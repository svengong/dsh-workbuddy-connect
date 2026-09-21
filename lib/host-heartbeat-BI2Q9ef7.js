import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { basename, join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { createDecipheriv, createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
//#region src/at-rest.ts
/**
* WorkBuddy 5.6.0 at-rest field encryption.
*
* The desktop app seals sensitive auth fields as `{"$wbEncrypted":1,"envelope"}`
* envelopes, where the envelope is base64 over
* `{suite, keyId, nonce, authTag, ciphertext}` sealed with AES-256-GCM under a
* per-install *protector* key. That key is not on disk, not in the keychain and
* not in the plugin's reach: it is compiled into the app's patched Electron
* framework and is only obtainable from the app's own binary, which exposes it
* through the private linked binding `electron_browser_workbuddy_storage`.
*
* This module reuses that accessor the way the app itself does — by running the
* app's Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1`), which boots a
* plain Node runtime with no GUI, no app main, no keychain prompt and no
* network — derives the protector key exactly as the app does, and opens the
* envelopes. The key and the plaintext never touch disk; only the derived key is
* memoized in-process.
*
* @module dsh-workbuddy-connect/at-rest
*/
const run = promisify(execFile);
/** Env override for the WorkBuddy desktop executable, for support and tests. */
const WORKBUDDY_APP_BINARY_ENV = "WORKBUDDY_APP_BINARY";
/** How long the accessor probe may take before the unlock is given up on. */
const PROBE_TIMEOUT_MS = 15e3;
/**
* The in-process probe. It prints `loggerGet()`'s JSON verbatim on stdout; the
* parent parses it. No shell is involved (`execFile` with an argv array), so the
* source needs no quoting beyond being one argument.
*/
const ACCESSOR_PROBE = "process.stdout.write(process._linkedBinding(\"electron_browser_workbuddy_storage\").loggerGet())";
/** Thrown when the sealed fields cannot be opened locally. */
var WorkBuddyAtRestError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "WorkBuddyAtRestError";
	}
};
/** Whether a JSON value is a sealed field node. */
function isSealedField(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value;
	return record["$wbEncrypted"] === 1 && typeof record["envelope"] === "string";
}
/**
* The protector key the app derives for a build-key payload.
*
* The hash covers the *base64 text* of the secret, not its decoded bytes — that
* detail is what makes the derivation match the app's `keyId`.
*/
function deriveProtectorKey(secretBase64) {
	return createHash("sha256").update(Buffer.from(secretBase64, "utf8")).digest();
}
/** The app's key id for a derived key: `sha256(key).hex[0:16]`. */
function deriveKeyId(key) {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
const FRAMINGS = {
	file: {
		label: "WBEF1",
		index: 1
	},
	field: {
		label: "WBEV1",
		index: 2
	}
};
/** Big-endian u32 length prefix, the app's framing primitive. */
function lengthPrefixed(value) {
	const body = Buffer.from(value, "utf8");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(body.length, 0);
	return Buffer.concat([length, body]);
}
/**
* The GCM additional authenticated data the app builds for one envelope.
*
* Layout: `"WB-AAD\0" | 0x01 | u32len+"WBEF1"|"WBEV1" | u32len+"sym-v1" |
* u32be(suite) | u32len+keyId | framingIndex | 0x00 | 0x00`.
*/
function envelopeAad(keyId, framing, suite) {
	const { label, index } = FRAMINGS[framing];
	const suiteField = Buffer.alloc(4);
	suiteField.writeUInt32BE(suite, 0);
	return Buffer.concat([
		Buffer.from("WB-AAD\0", "ascii"),
		Buffer.from([1]),
		lengthPrefixed(label),
		lengthPrefixed("sym-v1"),
		suiteField,
		lengthPrefixed(keyId),
		Buffer.from([
			index,
			0,
			0
		])
	]);
}
/** Decode one sealed field's envelope JSON. */
function decodeEnvelope(node) {
	let parsed;
	try {
		parsed = JSON.parse(Buffer.from(node.envelope, "base64").toString("utf8"));
	} catch {
		throw new WorkBuddyAtRestError("a sealed field does not carry a decodable envelope");
	}
	if (typeof parsed !== "object" || parsed === null) throw new WorkBuddyAtRestError("a sealed field envelope is not an object");
	const envelope = parsed;
	for (const field of [
		"suite",
		"keyId",
		"nonce",
		"authTag",
		"ciphertext"
	]) {
		const value = envelope[field];
		if (typeof value !== "string" && !(field === "suite" && typeof value === "number")) throw new WorkBuddyAtRestError(`a sealed field envelope is missing ${field}`);
	}
	if (envelope["suite"] !== 1) throw new WorkBuddyAtRestError(`unsupported at-rest envelope suite ${String(envelope["suite"])}`);
	return {
		suite: envelope["suite"],
		keyId: envelope["keyId"],
		nonce: envelope["nonce"],
		authTag: envelope["authTag"],
		ciphertext: envelope["ciphertext"]
	};
}
/** Open one sealed field. */
function openSealedField(node, key, framing) {
	const envelope = decodeEnvelope(node);
	if (envelope.keyId !== deriveKeyId(key)) throw new WorkBuddyAtRestError("a sealed field was sealed with a different key than the one derived");
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"), { authTagLength: 16 });
		decipher.setAAD(envelopeAad(envelope.keyId, framing, envelope.suite));
		decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
		return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
	} catch (error) {
		throw new WorkBuddyAtRestError(`a sealed field failed to decrypt (${error instanceof Error ? error.message : String(error)})`);
	}
}
/**
* Replace every sealed field in a parsed JSON document with its plaintext.
*
* Field envelopes are sealed with the protector key under the `field` framing,
* not with the keyblob's master key — the keyblob only matters for the
* `asym-v1` whole-file protection this plugin never needs.
*/
function openSealedFields(document, key) {
	const walk = (value) => {
		if (isSealedField(value)) return openSealedField(value, key, "field");
		if (Array.isArray(value)) return value.map(walk);
		if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
		return value;
	};
	return walk(document);
}
/** Where the WorkBuddy desktop executable lives, in probe order. */
function defaultAppBinaryCandidates() {
	const fromEnv = process.env[WORKBUDDY_APP_BINARY_ENV]?.trim();
	if (fromEnv !== void 0 && fromEnv !== "") return [fromEnv];
	if (process.platform !== "darwin") return [];
	const app = join("Contents", "MacOS", "Electron");
	return [join("/Applications", "WorkBuddy.app", app), join(homedir(), "Applications", "WorkBuddy.app", app)];
}
/** Reads the build-key payload out of the app binary (memoized per process). */
let cachedProtectorKey;
/**
* Derive the protector key from the app's own binary.
*
* Single-flight and memoized: the secret is per-install and constant for the
* lifetime of this process, so the probe runs at most once.
*/
function resolveProtectorKey(binaryOverride) {
	cachedProtectorKey ??= deriveFromAppBinary(binaryOverride).catch((error) => {
		cachedProtectorKey = void 0;
		throw error;
	});
	return cachedProtectorKey;
}
/** Drop the memoized key; diagnostics and tests only. */
function resetProtectorKeyCache() {
	cachedProtectorKey = void 0;
}
async function deriveFromAppBinary(binaryOverride) {
	const candidates = binaryOverride === void 0 ? defaultAppBinaryCandidates() : [binaryOverride];
	if (candidates.length === 0) throw new WorkBuddyAtRestError(`no WorkBuddy desktop binary is known on ${process.platform}`);
	let lastError;
	for (const binary of candidates) try {
		const { stdout } = await run(binary, ["-e", ACCESSOR_PROBE], {
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1"
			},
			timeout: PROBE_TIMEOUT_MS,
			maxBuffer: 1 << 20
		});
		return protectorKeyFromProbe(stdout);
	} catch (error) {
		lastError = error;
	}
	throw new WorkBuddyAtRestError(`the WorkBuddy desktop binary could not be read for the at-rest key (${lastError instanceof Error ? lastError.message : String(lastError)})`);
}
/** Parse the probe's stdout and derive the key; exported for tests. */
function protectorKeyFromProbe(stdout) {
	let payload;
	try {
		payload = JSON.parse(stdout);
	} catch {
		throw new WorkBuddyAtRestError("the WorkBuddy at-rest accessor did not return JSON");
	}
	if (typeof payload !== "object" || payload === null) throw new WorkBuddyAtRestError("the WorkBuddy at-rest accessor returned an unexpected payload");
	const candidate = payload;
	if (candidate.version !== 1 || typeof candidate.atRestSecretKey !== "string" || candidate.atRestSecretKey === "") throw new WorkBuddyAtRestError("the WorkBuddy at-rest accessor returned no usable secret");
	return deriveProtectorKey(candidate.atRestSecretKey);
}
/** The default unlocker: derive the key from the app binary and open the fields. */
function createAtRestUnlocker(options = {}) {
	return async (text) => {
		const opened = openSealedFields(JSON.parse(text), await resolveProtectorKey(options.binary));
		return JSON.stringify(opened);
	};
}
//#endregion
//#region src/auth.ts
/**
* WorkBuddy credential resolution. The primary source is the WorkBuddy
* desktop app's own auth file, read-only; a plugin-owned copy under
* `$DSH_HOME` holds token refreshes so the desktop file is never written.
* The effective credential is whichever of the two expires later, so a
* refresh by either side wins.
*
* @module dsh-workbuddy-connect/auth
*/
/** Basename of the plugin-owned credential copy inside the Harness home. */
const WORKBUDDY_AUTH_FILENAME = ".workbuddy-auth.json";
/** Env variable that overrides the desktop auth-file location. */
const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1;
/** Plugin-owned copy path inside the Harness home. */
function workbuddyOwnAuthPath() {
	return join(resolveDshHome(), WORKBUDDY_AUTH_FILENAME);
}
const DESKTOP_AUTH_RELATIVE_PATH = [
	"CodeBuddyExtension",
	"Data",
	"Public",
	"auth",
	"workbuddy-desktop.info"
];
/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl() {
	if (process.platform !== "linux") return false;
	if (process.env["WSL_DISTRO_NAME"] !== void 0 || process.env["WSL_INTEROP"] !== void 0) return true;
	return release().toLowerCase().includes("microsoft");
}
/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl(value) {
	const path = value?.trim();
	if (!path) return void 0;
	if (path.startsWith("/")) return path;
	const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path);
	if (drivePath === null) return void 0;
	return join("/mnt", drivePath[1].toLowerCase(), ...drivePath[2].split(/[\\/]+/u));
}
/** Windows desktop credential candidates visible from a WSL process. */
function wslDesktopAuthCandidates(home) {
	const profile = windowsPathForWsl(process.env["USERPROFILE"]) ?? join("/mnt/c/Users", basename(home));
	const localAppData = windowsPathForWsl(process.env["LOCALAPPDATA"]) ?? join(profile, "AppData", "Local");
	const roamingAppData = windowsPathForWsl(process.env["APPDATA"]) ?? join(profile, "AppData", "Roaming");
	return [join(localAppData, ...DESKTOP_AUTH_RELATIVE_PATH), join(roamingAppData, ...DESKTOP_AUTH_RELATIVE_PATH)];
}
/**
* Platform-default candidates for the WorkBuddy desktop app's auth file, in
* probe order. Windows probes both AppData roots: current builds write under
* `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%` (Roaming). WSL probes
* those same Windows locations through its mounted Windows profile before the
* native Linux location.
*/
function defaultDesktopAuthCandidates() {
	const home = homedir();
	if (process.platform === "darwin") return [join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info")];
	if (process.platform === "win32") return [join(home, "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"), join(home, "AppData", "Roaming", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info")];
	if (process.platform === "linux") {
		const linux = join(home, ".config", ...DESKTOP_AUTH_RELATIVE_PATH);
		return isWsl() ? [...wslDesktopAuthCandidates(home), linux] : [linux];
	}
	return [];
}
/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
function defaultDesktopAuthPath() {
	return defaultDesktopAuthCandidates()[0];
}
/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
	if (value <= 0) return 0;
	return value > 0xe8d4a51000 ? value : value * 1e3;
}
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/**
* Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
* nested form `{"auth":{...},"account":{...}}` and the flat panel form.
* Returns undefined when the document carries no access token.
*/
function parseWorkBuddyAuth(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	let auth;
	let identity;
	if (typeof document["auth"] === "object" && document["auth"] !== null) {
		auth = document["auth"];
		identity = typeof document["account"] === "object" && document["account"] !== null ? document["account"] : {};
	} else {
		auth = document;
		identity = document;
	}
	const accessToken = typeof auth["accessToken"] === "string" ? auth["accessToken"] : "";
	if (accessToken === "") return void 0;
	const expiresAtMs = typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0;
	const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : void 0;
	const enterpriseId = optionalString(identity["enterpriseId"]);
	const nickname = optionalString(identity["nickname"]);
	return {
		accessToken,
		refreshToken: typeof auth["refreshToken"] === "string" ? auth["refreshToken"] : "",
		expiresAtMs,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		domain: optionalString(auth["domain"]) ?? "",
		uid: optionalString(identity["uid"]) ?? "",
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		source: "desktop"
	};
}
/**
* Why {@link parseWorkBuddyAuth} would reject a document.
*
* The distinction is the whole point: "nobody is signed in" and "signed in,
* but the app sealed the token" are different problems with different fixes,
* and collapsing both into signed-out makes the second look like a bad key.
*/
function inspectWorkBuddyAuthDocument(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return "unparsable";
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "unparsable";
	const document = parsed;
	const auth = typeof document["auth"] === "object" && document["auth"] !== null ? document["auth"] : document;
	if (typeof auth["accessToken"] === "string" && auth["accessToken"] !== "") return "plaintext";
	if (isSealedField(auth["accessToken"]) || isSealedField(auth["refreshToken"])) return "encrypted-at-rest";
	return "no-token";
}
/** `code` carried by a credential the plugin cannot read; the shim routes on it. */
const WORKBUDDY_CREDENTIAL_UNREADABLE_CODE = "credential_unreadable";
/** Human-facing reason an otherwise valid sign-in is unusable here. */
const WORKBUDDY_ENCRYPTED_AT_REST_REASON = "the WorkBuddy desktop app sealed its stored sign-in with at-rest encryption (a `$wbEncrypted` envelope, app 5.6.0+)";
/**
* Thrown when the desktop app holds a valid sign-in the plugin cannot read.
*
* Deliberately not an ordinary "not signed in" failure: the credential file is
* intact and the user's session is fine. A caller that reports this as an
* authentication error makes the Harness render "API 密钥无效" / "API key is
* invalid", which is the wrong diagnosis and hides the real fix.
*/
var WorkBuddyCredentialUnreadableError = class extends Error {
	code = WORKBUDDY_CREDENTIAL_UNREADABLE_CODE;
	constructor(message) {
		super(message);
		this.name = "WorkBuddyCredentialUnreadableError";
	}
};
/** Serialize the plugin-owned copy. */
function ownDocument(credential) {
	return {
		version: OWN_FORMAT_VERSION,
		credential
	};
}
/** Parse the plugin-owned copy; other versions and shapes are rejected. */
function parseOwnDocument(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	if (document["version"] !== OWN_FORMAT_VERSION) return void 0;
	if (typeof document["credential"] !== "object" || document["credential"] === null) return void 0;
	const stored = document["credential"];
	const accessToken = typeof stored["accessToken"] === "string" ? stored["accessToken"] : "";
	if (accessToken === "") return void 0;
	const refreshExpiresAtMs = typeof stored["refreshExpiresAtMs"] === "number" ? stored["refreshExpiresAtMs"] : void 0;
	const enterpriseId = optionalString(stored["enterpriseId"]);
	const nickname = optionalString(stored["nickname"]);
	return {
		accessToken,
		refreshToken: typeof stored["refreshToken"] === "string" ? stored["refreshToken"] : "",
		expiresAtMs: typeof stored["expiresAtMs"] === "number" ? stored["expiresAtMs"] : 0,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		domain: optionalString(stored["domain"]) ?? "",
		uid: optionalString(stored["uid"]) ?? "",
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		source: "dsh"
	};
}
/** Whether a filesystem error reports an absent path. */
function isENOENT(error) {
	return error?.code === "ENOENT";
}
/**
* Read-only credential store with demand-driven refresh.
*
* Refresh policy: refresh only when the access token is inside the margin
* (or already expired), keep the refreshed credential in the plugin-owned
* copy, and never write the desktop app's file. A failed refresh still
* returns a not-yet-expired token so an unreachable refresh endpoint does
* not take down a working session.
*/
var WorkBuddyCredentialStore = class {
	refresh;
	unlock;
	logger;
	refreshMarginMs;
	ownPath;
	desktopPathOverride;
	inflight;
	/** Shape of the last desktop file read, for diagnosable signed-out states. */
	desktopDiagnosis;
	/** Why the last at-rest unlock attempt failed, when it did. */
	unlockFailure;
	/** Whether the one-line unlock notice has been logged. */
	unlockLogged = false;
	constructor(options) {
		this.refresh = options.refresh;
		this.unlock = options.unlock ?? createAtRestUnlocker();
		this.logger = options.logger;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
		this.ownPath = options.ownPath ?? workbuddyOwnAuthPath();
		this.desktopPathOverride = options.desktopPath;
	}
	/**
	* Configuration precedence for the desktop file: the plugin's configured
	* path, then the environment variable, then the platform defaults. An
	* explicit path is used verbatim; the defaults are a probe order.
	*/
	resolveDesktopCandidates() {
		const fromEnv = process.env[WORKBUDDY_AUTH_FILE_ENV];
		const explicit = this.desktopPathOverride ?? (fromEnv !== void 0 && fromEnv.trim() !== "" ? fromEnv : void 0);
		if (explicit !== void 0) return [explicit];
		return defaultDesktopAuthCandidates();
	}
	resolveDesktopPath() {
		return this.resolveDesktopCandidates()[0];
	}
	/**
	* Repoint the desktop file; a settings change applies on the next read.
	*/
	setDesktopPath(path) {
		this.desktopPathOverride = path;
	}
	/** The resolved desktop auth-file path, for diagnostics. */
	desktopAuthPath() {
		return this.resolveDesktopPath();
	}
	/** The plugin-owned copy path, for diagnostics. */
	ownAuthPath() {
		return this.ownPath;
	}
	/** Read the freshest stored credential without refreshing anything. */
	async current() {
		const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()]);
		if (desktop === void 0) return own;
		if (own === void 0) return desktop;
		return own.expiresAtMs > desktop.expiresAtMs ? own : desktop;
	}
	/**
	* The credential to send upstream: {@link current}, refreshed on demand.
	* Single-flight, so parallel requests share one refresh.
	*/
	async resolve() {
		const credential = await this.current();
		if (credential === void 0) {
			const unreadable = this.unreadableReason();
			if (unreadable !== void 0) throw new WorkBuddyCredentialUnreadableError(`workbuddy: ${unreadable}`);
			const candidates = this.resolveDesktopCandidates();
			const desktop = candidates.length > 0 ? candidates.join(" or ") : "(no desktop path on this platform)";
			throw new Error(`workbuddy: no signed-in WorkBuddy account found; sign in once in the WorkBuddy desktop app (expected ${desktop} or WORKBUDDY_AUTH_FILE), or refresh an existing session`);
		}
		if (!this.needsRefresh(credential)) return credential;
		this.inflight ??= this.refreshNow(credential).finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
	/**
	* Why the stored sign-in is unusable, when the last desktop read could tell.
	*
	* Only the encrypted-at-rest shape is reported: every other rejection keeps
	* the long-standing "nobody is signed in" wording, which is accurate for an
	* absent or token-less file. When the local unlock failed, its reason is
	* carried too — that is the difference between "we cannot open this" and
	* "your key is wrong".
	*/
	unreadableReason() {
		if (this.desktopDiagnosis !== "encrypted-at-rest") return void 0;
		const path = this.resolveDesktopPath() ?? "(unresolved)";
		const outcome = this.unlockFailure === void 0 ? `the sealed sign-in file at ${path} could not be read` : `unlocking it locally failed (${this.unlockFailure})`;
		return `${WORKBUDDY_ENCRYPTED_AT_REST_REASON}; ${outcome}, so keep the desktop app signed in`;
	}
	/** Read-only sign-in summary; never refreshes and never throws. */
	async status() {
		try {
			const credential = await this.current();
			if (credential === void 0) {
				const reason = this.unreadableReason();
				return reason === void 0 ? { state: "signed-out" } : {
					state: "signed-out",
					reason
				};
			}
			return {
				state: "signed-in",
				expiresAtMs: credential.expiresAtMs,
				...credential.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
				...credential.nickname === void 0 ? {} : { nickname: credential.nickname },
				...credential.domain === "" ? {} : { domain: credential.domain },
				source: credential.source
			};
		} catch (error) {
			return {
				state: "signed-out",
				reason: error instanceof Error ? error.message : String(error)
			};
		}
	}
	/** Remove the plugin-owned copy; the desktop file is untouched. */
	async logout() {
		await rm(this.ownPath, { force: true });
		await rm(`${this.ownPath}.lock`, { force: true });
	}
	needsRefresh(credential) {
		if (credential.expiresAtMs <= 0) return true;
		return Date.now() + this.refreshMarginMs >= credential.expiresAtMs;
	}
	async refreshNow(credential) {
		if (credential.refreshToken === "") {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error("workbuddy: access token expired and no refresh token is stored; sign in again in the WorkBuddy desktop app");
		}
		try {
			const outcome = await this.refresh(credential);
			const refreshed = {
				...credential,
				accessToken: outcome.accessToken,
				...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
				expiresAtMs: outcome.expiresInSec !== void 0 ? Date.now() + outcome.expiresInSec * 1e3 : credential.expiresAtMs,
				...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain },
				source: "dsh"
			};
			await this.saveOwn(refreshed);
			return refreshed;
		} catch (error) {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error(`workbuddy: token refresh failed and the access token is expired (${String(error)}); open the WorkBuddy desktop app once to sign in again`);
		}
	}
	async saveOwn(credential) {
		await withFileLock(this.ownPath, async () => {
			await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		});
	}
	/**
	* Read the first desktop candidate that exists. Only an absent file
	* (ENOENT) falls through to the next candidate; a file that is present
	* but unparsable is authoritative for its slot, so a stale older-version
	* file never silently wins over a broken newer one.
	*/
	async readDesktop() {
		for (const desktopPath of this.resolveDesktopCandidates()) try {
			const text = await readFile(desktopPath, "utf8");
			const credential = parseWorkBuddyAuth(text);
			if (credential !== void 0) {
				this.desktopDiagnosis = void 0;
				this.unlockFailure = void 0;
				return credential;
			}
			this.desktopDiagnosis = inspectWorkBuddyAuthDocument(text);
			if (this.desktopDiagnosis === "encrypted-at-rest") return await this.unlockSealed(text);
			return;
		} catch (error) {
			if (!isENOENT(error)) throw error;
		}
		this.desktopDiagnosis = void 0;
		this.unlockFailure = void 0;
	}
	/**
	* Open a sealed sign-in with the local unlocker.
	*
	* A failure is recorded rather than thrown: the caller reports it as the
	* reason the stored sign-in is unusable — accurate and actionable — while the
	* next read retries, so a transient probe failure never sticks.
	*/
	async unlockSealed(text) {
		try {
			const recovered = parseWorkBuddyAuth(await this.unlock(text));
			if (recovered === void 0) {
				this.unlockFailure = "the unlocked document carried no access token";
				return;
			}
			this.unlockFailure = void 0;
			if (!this.unlockLogged) {
				this.unlockLogged = true;
				this.logger?.info("dsh-workbuddy-connect: opened the WorkBuddy desktop sign-in by unlocking its at-rest envelope locally (the app's Electron binary supplied the protector key; nothing was sent anywhere)");
			}
			return {
				...recovered,
				source: "desktop-unlocked"
			};
		} catch (error) {
			this.unlockFailure = error instanceof Error ? error.message : String(error);
			return;
		}
	}
	async readOwn() {
		try {
			return parseOwnDocument(await readFile(this.ownPath, "utf8"));
		} catch (error) {
			if (isENOENT(error)) return void 0;
			return;
		}
	}
	/** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
	async desktopFilePresent() {
		for (const desktopPath of this.resolveDesktopCandidates()) try {
			if ((await stat(desktopPath)).isFile()) return true;
		} catch {}
		return false;
	}
};
//#endregion
//#region src/v3-config.ts
/**
* Local product-config cache reader.
*
* The WorkBuddy desktop app and CLI pull their runtime configuration from
* `https://copilot.tencent.com/v3/config` and mirror the answer to disk at
* `~/.workbuddy/cache/acc-product-config-v3.json`. That mirrored document is
* the authoritative product catalog: it is the same source the app renders its
* own model picker from, and it is the only source that carries the models the
* `cli` agent exposes (`hy4-preview-ioa`, `echo`, …). The
* `/console/enterprises/{id}/models` endpoint returns a narrower catalog that
* omits them.
*
* Reading the on-disk mirror keeps catalog discovery entirely local — no
* network round trip and no credential — and keeps this plugin's catalog from
* drifting away from the one the desktop app shows.
*
* @module dsh-workbuddy-connect/v3-config
*/
/** Basename of the cached `/v3/config` product document. */
const PRODUCT_CONFIG_CACHE_FILENAME = "acc-product-config-v3.json";
/**
* Env override for the cached product document's location. The desktop app
* publishes the same name in the document's `productConfigPathEnv` field, so
* pointing it at a fixture pins the catalog for tests and for support runs.
*/
const PRODUCT_CONFIG_PATH_ENV = "ACC_PRODUCT_CONFIG_PATH";
/** Name of the agent whose model list the CLI — and this plugin — exposes. */
const CLI_AGENT_NAME = "cli";
/** Cached product document location for the current platform. */
function defaultProductConfigPath() {
	return join(homedir(), ".workbuddy", "cache", PRODUCT_CONFIG_CACHE_FILENAME);
}
/** Cached product document location: env override first, then the default. */
function resolveProductConfigPath() {
	const fromEnv = process.env[PRODUCT_CONFIG_PATH_ENV];
	return fromEnv !== void 0 && fromEnv.trim() !== "" ? fromEnv : defaultProductConfigPath();
}
function asRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	return value;
}
/** A field that is a finite number greater than zero. */
function positiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
/**
* The context ceiling, preferring the per-variant input limit.
*
* `maxInputTokens` is per-variant and authoritative. `contextWindow` is only
* the vendor family's default and over-reports for constrained variants —
* `claude-opus-4.8` carries `contextWindow.defaultLength: 1000000` while its
* real input limit is 200000 — so it is the last resort, never the first.
*/
function contextLength(record) {
	const input = positiveNumber(record["maxInputTokens"]);
	if (input !== void 0) return input;
	const allowed = positiveNumber(record["maxAllowedSize"]);
	if (allowed !== void 0) return allowed;
	const window = record["contextWindow"];
	if (typeof window === "number") return positiveNumber(window);
	const wrapped = asRecord(window);
	return wrapped === void 0 ? void 0 : positiveNumber(wrapped["defaultLength"]);
}
/** One `models[]` entry as an upstream model, or undefined when unusable. */
function toModel(raw) {
	const record = asRecord(raw);
	if (record === void 0) return void 0;
	const id = typeof record["id"] === "string" ? record["id"] : "";
	if (id === "" || record["disabled"] === true) return void 0;
	const contextWindow = contextLength(record);
	const maxTokens = positiveNumber(record["maxOutputTokens"]);
	if (contextWindow === void 0 || maxTokens === void 0) return void 0;
	return {
		id,
		name: typeof record["name"] === "string" && record["name"] !== "" ? record["name"] : id,
		contextWindow,
		maxTokens,
		...resolveUpstreamReasoning(record),
		...resolveUpstreamBilling(record),
		supportsImages: record["supportsImages"] === true && record["disabledMultimodal"] !== true
	};
}
/**
* The `cli` agent's model ids from an `agents[]` array. The document names the
* CLI agent both as `name: "cli"` and `description: "cli agent"`, so `name`
* wins when present and the description is the fallback.
*/
function cliAgentModelIds(agents) {
	if (!Array.isArray(agents)) return void 0;
	let fallback;
	for (const raw of agents) {
		const agent = asRecord(raw);
		if (agent === void 0 || !Array.isArray(agent["models"])) continue;
		const ids = agent["models"].filter((id) => typeof id === "string");
		if (ids.length === 0) continue;
		if (agent["name"] === CLI_AGENT_NAME) return ids;
		const description = typeof agent["description"] === "string" ? agent["description"].trim().toLowerCase() : "";
		if (fallback === void 0 && (description === "cli agent" || description.startsWith("cli agent"))) fallback = ids;
	}
	return fallback;
}
/**
* Parse a cached product document into the `cli` agent's model list, keeping
* the agent's order. Throws a descriptive error when the document is absent,
* malformed, or lists no cli models, so the caller can fall back to the static
* catalog with a useful log line.
*/
function parseProductConfig(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`workbuddy product config is not valid JSON: ${String(error)}`);
	}
	const document = asRecord(parsed);
	if (document === void 0) throw new Error("workbuddy product config is not a JSON object");
	const byId = /* @__PURE__ */ new Map();
	for (const raw of Array.isArray(document["models"]) ? document["models"] : []) {
		const model = toModel(raw);
		if (model !== void 0) byId.set(model.id, model);
	}
	const cliIds = cliAgentModelIds(document["agents"]);
	if (cliIds === void 0 || cliIds.length === 0) throw new Error("workbuddy product config lists no cli agent models");
	const models = [];
	for (const id of cliIds) {
		const model = byId.get(id);
		if (model !== void 0) models.push(model);
	}
	if (models.length === 0) throw new Error("workbuddy product config resolved to an empty cli model list");
	return models;
}
/**
* Read the `cli` agent's model list from the cached product document. The
* document is refreshed by the WorkBuddy desktop app, so a stale or missing
* file means the app has not run recently; the error says so.
*/
async function readProductConfigModels(path = resolveProductConfigPath()) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new Error(`workbuddy product config cache unreadable at ${path} (${String(error)}); open the WorkBuddy desktop app once so it refreshes`);
	}
	return parseProductConfig(text);
}
//#endregion
//#region src/upstream.ts
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
const CLIENT_UA = "WorkBuddy/5.3.14";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"credit not enough",
	"not enough credit",
	"积分不足",
	"额度不足",
	"余额不足",
	"积分用完",
	"额度用尽",
	"没有积分"
];
/** The concrete effort spellings WorkBuddy exposes on the wire. */
const EFFORT_VALUES = [
	"off",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Promotional badge keys the upstream tags carry, minus their color suffix. */
const BADGE_PREFIX = "badge:";
/** Parse the upstream `reasoning` object into {@link WorkBuddyModelReasoning}. */
function resolveUpstreamReasoning(wrapped) {
	const supports = wrapped["supportsReasoning"] === true;
	const onlyReasoning = wrapped["onlyReasoning"] === true;
	const rawReasoning = wrapped["reasoning"];
	let supportedEfforts;
	let defaultEffort;
	let canDisableThinking = true;
	if (typeof rawReasoning === "object" && rawReasoning !== null && !Array.isArray(rawReasoning)) {
		const reasoning = rawReasoning;
		const rawEfforts = reasoning["supportedEfforts"];
		if (Array.isArray(rawEfforts)) {
			const efforts = rawEfforts.filter((value) => typeof value === "string" && EFFORT_VALUES.includes(value));
			if (efforts.length > 0) supportedEfforts = efforts;
		}
		if (typeof reasoning["defaultEffort"] === "string" && EFFORT_VALUES.includes(reasoning["defaultEffort"])) defaultEffort = reasoning["defaultEffort"];
		else if (typeof reasoning["effort"] === "string" && EFFORT_VALUES.includes(reasoning["effort"])) defaultEffort = reasoning["effort"];
		canDisableThinking = reasoning["canDisableThinking"] === true;
	}
	return { reasoning: {
		supports,
		onlyReasoning,
		...supportedEfforts === void 0 ? {} : { supportedEfforts },
		...defaultEffort === void 0 ? {} : { defaultEffort },
		canDisableThinking
	} };
}
/**
* Reduce an upstream credits string to its language-neutral display form.
*
* The host LLM seam carries this text to the browser, and the host has no
* locale service — whatever string is produced here is shown verbatim in every
* UI language. The upstream is inconsistent in a way that matters: some catalog
* rows report a bare multiplier (`x0.79`) and others append a unit word
* (`x0.79 credits`), and the unit word would pin the display to English.
* Dropping a trailing `credits` (case-insensitive, singular or plural) yields
* the one spelling that reads identically in every language.
*
* @param credits - raw upstream credits string, e.g. `"x0.79 credits"`.
* @returns the bare multiplier, or undefined when nothing displayable remains.
*/
function normalizeCredits(credits) {
	if (credits === void 0) return void 0;
	const trimmed = credits.trim();
	if (trimmed === "") return void 0;
	if (/^credits?$/iu.test(trimmed)) return void 0;
	const bare = trimmed.replace(/\s+credits?$/iu, "").trim();
	return bare === "" ? void 0 : bare;
}
/** Parse the upstream `tags` / `credits` fields into billing metadata. */
function resolveUpstreamBilling(wrapped) {
	const rawCredits = wrapped["credits"];
	const credits = typeof rawCredits === "string" && rawCredits.trim() !== "" ? rawCredits.trim() : void 0;
	const badges = [];
	const rawTags = wrapped["tags"];
	if (Array.isArray(rawTags)) for (const tag of rawTags) {
		if (typeof tag !== "string") continue;
		if (!tag.toLowerCase().startsWith(BADGE_PREFIX)) continue;
		const label = tag.slice(6).split(":")[0] ?? tag.slice(6);
		if (label !== "") badges.push(label);
	}
	const free = credits !== void 0 && /^x?0\.0+$/u.test(credits);
	return { billing: {
		...credits === void 0 ? {} : { credits },
		...badges.length === 0 ? {} : { badges },
		free
	} };
}
/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS = ["Offline user session not found", "12153"];
/** Classify an upstream failure from its HTTP status and body excerpt. */
function classifyUpstreamError(status, body) {
	if (status === 402) return "hard_credit";
	const lower = body.toLowerCase();
	for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
	for (const marker of SESSION_DEAD_MARKERS) if (body.includes(marker)) return "session_dead";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	if (status >= 400) return "client";
	return "client";
}
/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
function regionOf(domain) {
	const lowered = domain.trim().toLowerCase();
	if (lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai")) return "global";
	return "cn";
}
function chatBase(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_CHAT_BASE;
}
function billingBase(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
function originReferer(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
/** Headers every upstream request shares. */
function commonHeaders(credential) {
	return {
		"Accept": "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": originReferer(credential),
		"Referer": `${originReferer(credential)}/`,
		"User-Agent": CLIENT_UA
	};
}
/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential) {
	return {
		...commonHeaders(credential),
		"Content-Type": "application/json",
		...credential.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
		...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
		...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
		"X-Product": "SaaS",
		"X-IDE-Type": "WorkBuddy",
		"X-IDE-Name": "WorkBuddy",
		"X-IDE-Version": "5.3.14"
	};
}
/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential) {
	const headers = {
		...commonHeaders(credential),
		"X-Refresh-Token": credential.refreshToken,
		"X-Auth-Refresh-Source": "workbuddy"
	};
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
	return headers;
}
/** Billing request headers. */
function billingHeaders(credential) {
	const headers = {
		"Authorization": `Bearer ${credential.accessToken}`,
		"Accept": "application/json",
		"Content-Type": "application/json"
	};
	if (credential.uid !== "") headers["X-User-Id"] = credential.uid;
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
		headers["X-Enterprise-Id"] = credential.enterpriseId;
		headers["X-Tenant-Id"] = credential.enterpriseId;
	}
	if (credential.domain !== "") headers["X-Domain"] = credential.domain;
	return headers;
}
/**
* Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
* force `stream: true` (the upstream rejects non-streaming), flatten
* `tool_choice` (the upstream's field is a string; object forms return 400),
* and rewrite `developer` messages as `system`.
*
* The `developer` rewrite is load-bearing: pi-ai emits the system prompt as
* `role: "developer"` (the OpenAI convention it adopted), but the WorkBuddy
* upstream rejects that role with HTTP 400 code 11128 ("Illegal API
* invocation from an unapproved channel"). Rewriting to `system` is the
* compatible spelling the upstream accepts.
*/
function prepareChatBody(source) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const obj = body;
	obj["stream"] = true;
	normalizeDeveloperRole(obj);
	normalizeToolChoice(obj);
	return JSON.stringify(obj);
}
/** Rewrite `role: "developer"` messages to `role: "system"` (upstream rejects developer). */
function normalizeDeveloperRole(obj) {
	const messages = obj["messages"];
	if (!Array.isArray(messages)) return;
	for (const message of messages) {
		if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
		const wrapped = message;
		if (wrapped["role"] === "developer") wrapped["role"] = "system";
	}
}
/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj) {
	const suppress = () => {
		delete obj["tools"];
		delete obj["functions"];
	};
	if (!("tool_choice" in obj)) return;
	const choice = obj["tool_choice"];
	if (typeof choice === "string") {
		if (choice.trim().toLowerCase() === "none") {
			delete obj["tool_choice"];
			suppress();
		}
		return;
	}
	if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
		const wrapped = choice;
		const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
		if (type === "none") {
			delete obj["tool_choice"];
			suppress();
		} else if (type === "auto" || type === "required") obj["tool_choice"] = type;
		else if (type === "function") {
			const fn = typeof wrapped["function"] === "object" && wrapped["function"] !== null ? wrapped["function"] : void 0;
			let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
			if (name === "" && typeof wrapped["name"] === "string") name = wrapped["name"];
			name = name.trim();
			obj["tool_choice"] = name !== "" ? name : "auto";
		} else delete obj["tool_choice"];
		return;
	}
	delete obj["tool_choice"];
}
async function readEnvelope(response) {
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`);
	const document = parsed;
	return {
		code: typeof document["code"] === "number" ? document["code"] : 0,
		msg: typeof document["msg"] === "string" ? document["msg"] : "",
		data: "data" in document ? document["data"] : void 0
	};
}
/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status, envelope) {
	const kind = classifyUpstreamError(status, envelope.msg);
	return /* @__PURE__ */ new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`);
}
/**
* Upstream HTTP client. One instance serves the whole plugin; requests take
* the credential explicitly so token refreshes apply on the next call.
*/
var WorkBuddyUpstreamClient = class {
	/** POST the chat endpoint; a successful answer is the raw SSE response. */
	async chatStream(credential, bodyJson, signal) {
		let response;
		try {
			response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body: bodyJson,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
		return {
			ok: false,
			status: response.status,
			kind: classifyUpstreamError(response.status, text),
			message: text
		};
	}
	/** POST the token-refresh endpoint; the caller merges the outcome. */
	async refreshToken(credential) {
		const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
			method: "POST",
			headers: refreshHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
		if (accessToken === "") throw new Error("workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app");
		const outcome = { accessToken };
		if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") outcome.refreshToken = data["refreshToken"];
		if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) outcome.expiresInSec = data["expiresIn"];
		if (typeof data["domain"] === "string" && data["domain"] !== "") outcome.domain = data["domain"];
		return outcome;
	}
	/**
	* The `cli` agent's model catalog, sourced from a single tier: the local
	* product-config cache (`~/.workbuddy/cache/acc-product-config-v3.json`) —
	* the desktop app's on-disk mirror of `/v3/config`, and the same document its
	* own model picker renders from. It needs no credential, makes no network
	* call, and carries the full cli roster (including cli-only models such as
	* `hy4-preview-ioa` and `echo` that the enterprise endpoint omits).
	*
	* There is deliberately no network or static fallback: a cache miss throws,
	* and the caller serves an empty catalog. This keeps the plugin's model list
	* from ever drifting away from the one the WorkBuddy desktop app shows.
	*/
	async fetchModels() {
		return await readProductConfigModels();
	}
	/** POST the billing endpoint for the aggregated remaining credit. */
	async fetchCredits(credential) {
		const now = /* @__PURE__ */ new Date();
		const format = (date) => [
			date.getFullYear().toString().padStart(4, "0"),
			(date.getMonth() + 1).toString().padStart(2, "0"),
			date.getDate().toString().padStart(2, "0")
		].join("-") + " " + [
			date.getHours().toString().padStart(2, "0"),
			date.getMinutes().toString().padStart(2, "0"),
			date.getSeconds().toString().padStart(2, "0")
		].join(":");
		const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({
				PageNumber: 1,
				PageSize: 100,
				ProductCode: "p_tcaca",
				Status: [0, 3],
				PackageEndTimeRangeBegin: format(now),
				PackageEndTimeRangeEnd: format(new Date(now.getTime() + 3185136e6))
			}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const responseWrapper = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const data = typeof responseWrapper["Response"] === "object" && responseWrapper["Response"] !== null ? responseWrapper["Response"] : {};
		const inner = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : {};
		const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
		const accounts = [];
		let total = 0;
		for (const raw of rawAccounts) {
			if (typeof raw !== "object" || raw === null) continue;
			const account = raw;
			const numberField = (key) => typeof account[key] === "number" ? account[key] : 0;
			const size = numberField("CycleCapacitySize");
			const cycleRemain = numberField("CycleCapacityRemain");
			const cycleUsed = numberField("CycleCapacityUsed");
			const capacityRemain = numberField("CapacityRemain");
			let remain;
			if (size > 0) remain = cycleRemain;
			else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain;
			else remain = capacityRemain;
			if (remain < 0) remain = 0;
			total += remain;
			accounts.push({
				packageName: typeof account["PackageName"] === "string" ? account["PackageName"] : "(unnamed)",
				remain,
				size: size > 0 ? size : numberField("CapacitySize")
			});
		}
		return {
			total,
			accounts
		};
	}
};
//#endregion
//#region src/version.ts
const WORKBUDDY_CONNECT_VERSION = "0.4.3";
/** Identity of the sources this bundle was built from (see the module header). */
const WORKBUDDY_CONNECT_BUILD = "ab0389884b";
//#endregion
//#region src/host-heartbeat.ts
/**
* Host-side heartbeat: a small JSON file written under `$DSH_HOME` once the
* `workbuddy` provider is registered. The status CLI reads it to report
* whether the host bundle is alive, independent of the browser card.
*
* The browser (client) bundle cannot write files; its health is reported
* only through `console.error` on failure (see `src/client/index.tsx`).
* This asymmetry is intentional: the host is the load-bearing half, and
* a missing heartbeat unambiguously means the host never started.
*
* @module dsh-workbuddy-connect/host-heartbeat
*/
/** Basename of the host heartbeat file inside the Harness home. */
const WORKBUDDY_HOST_HEARTBEAT_FILENAME = ".workbuddy-host-heartbeat.json";
/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1;
/** Absolute path of the host heartbeat file. */
function workbuddyHostHeartbeatPath() {
	return join(resolveDshHome(), WORKBUDDY_HOST_HEARTBEAT_FILENAME);
}
/**
* Write (or overwrite) the heartbeat after the host bundle registered the
* provider. A failed write is non-fatal: the host is already running, and
* the status CLI will simply report "heartbeat missing" rather than failing.
*/
async function writeHostHeartbeat() {
	const document = {
		version: HEARTBEAT_FORMAT_VERSION,
		package: "dsh-workbuddy-connect-oo",
		pluginVersion: WORKBUDDY_CONNECT_VERSION,
		pluginBuild: WORKBUDDY_CONNECT_BUILD,
		registeredAt: Date.now(),
		pid: process.pid
	};
	try {
		await writeFile(workbuddyHostHeartbeatPath(), JSON.stringify(document), "utf8");
	} catch {}
}
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
async function clearHostHeartbeat() {
	try {
		await rm(workbuddyHostHeartbeatPath(), { force: true });
	} catch {}
}
/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
async function readHostHeartbeat() {
	let raw;
	try {
		raw = await readFile(workbuddyHostHeartbeatPath(), "utf8");
	} catch {
		return;
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed.version === HEARTBEAT_FORMAT_VERSION && parsed.package === "dsh-workbuddy-connect-oo" && typeof parsed.registeredAt === "number" && typeof parsed.pid === "number") return {
			version: HEARTBEAT_FORMAT_VERSION,
			package: "dsh-workbuddy-connect-oo",
			pluginVersion: typeof parsed.pluginVersion === "string" ? parsed.pluginVersion : "unknown",
			pluginBuild: typeof parsed.pluginBuild === "string" ? parsed.pluginBuild : "unknown",
			registeredAt: parsed.registeredAt,
			pid: parsed.pid
		};
	} catch {}
}
/**
* Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
* when it cannot be determined (no such PID, platform lacks a readable source).
*
* - macOS / Linux: `ps -o lstart=` prints a local-time "EEE MMM DD HH:MM:SS YYYY";
*   `Date.parse` resolves it against the local clock, which matches how
*   `registeredAt` (a `Date.now()` absolute value) is expressed.
* - Windows: WMI `CreationDate` is UTC (`YYYYMMDDHHMMSS.mmm+zzzz`); parsed with
*   `Date.UTC`, again comparable to `registeredAt`.
*
* Failures return `undefined` so callers can fall back to plain PID liveness
* rather than mis-report a running host as dead.
*/
function processStartTimeMs(pid) {
	try {
		if (process.platform === "win32") {
			const m = execFileSync("wmic", [
				"process",
				"where",
				`processid=${pid}`,
				"get",
				"CreationDate"
			], {
				encoding: "utf8",
				windowsHide: true
			}).match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d{4})/);
			if (m === null) return void 0;
			const [, y, mo, d, h, mi, s] = m;
			const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
			return Number.isFinite(ms) ? ms : void 0;
		}
		const out = execFileSync("ps", [
			"-o",
			"lstart=",
			"-p",
			String(pid)
		], {
			encoding: "utf8",
			env: {
				...process.env,
				LC_ALL: "C",
				LANG: "C"
			}
		}).trim();
		if (out === "") return void 0;
		const ms = Date.parse(out);
		return Number.isFinite(ms) ? ms : void 0;
	} catch {
		return;
	}
}
/**
* Whether the heartbeat's PID is still alive *and* still the same process that
* registered it. A stale heartbeat (host crashed without clearing the file)
* is distinguished from a live host by two checks:
*
* 1. `process.kill(pid, 0)` — the PID exists (signal 0 tests existence).
* 2. The process holding that PID started at or before `registeredAt`. A host
*    that registered the heartbeat must have been started before writing it,
*    so `start <= registeredAt`; a recycled PID belongs to an unrelated process
*    started after the host died, so `start > registeredAt` correctly reads dead.
*
* PID-only detection is not enough: after a crash the OS may hand the same PID
* to an unrelated process, and the un-cleared stale heartbeat would otherwise
* produce a false "Host running". When the process start time cannot be read
* (e.g. unsupported platform) the check degrades to plain PID liveness.
*/
function isHeartbeatProcessAlive(heartbeat) {
	try {
		process.kill(heartbeat.pid, 0);
	} catch {
		return false;
	}
	const startAtMs = processStartTimeMs(heartbeat.pid);
	if (startAtMs === void 0) return true;
	return startAtMs <= heartbeat.registeredAt;
}
//#endregion
export { createAtRestUnlocker as A, defaultDesktopAuthCandidates as C, workbuddyOwnAuthPath as D, parseWorkBuddyAuth as E, isSealedField as F, openSealedFields as I, resetProtectorKeyCache as L, deriveKeyId as M, deriveProtectorKey as N, WORKBUDDY_APP_BINARY_ENV as O, envelopeAad as P, resolveProtectorKey as R, WorkBuddyCredentialUnreadableError as S, inspectWorkBuddyAuthDocument as T, WORKBUDDY_AUTH_FILENAME as _, readHostHeartbeat as a, WORKBUDDY_ENCRYPTED_AT_REST_REASON as b, WORKBUDDY_CONNECT_BUILD as c, classifyUpstreamError as d, normalizeCredits as f, resolveProductConfigPath as g, readProductConfigModels as h, processStartTimeMs as i, defaultAppBinaryCandidates as j, WorkBuddyAtRestError as k, WORKBUDDY_CONNECT_VERSION as l, regionOf as m, clearHostHeartbeat as n, workbuddyHostHeartbeatPath as o, prepareChatBody as p, isHeartbeatProcessAlive as r, writeHostHeartbeat as s, WORKBUDDY_HOST_HEARTBEAT_FILENAME as t, WorkBuddyUpstreamClient as u, WORKBUDDY_AUTH_FILE_ENV as v, defaultDesktopAuthPath as w, WorkBuddyCredentialStore as x, WORKBUDDY_CREDENTIAL_UNREADABLE_CODE as y };
