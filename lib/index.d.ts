import z from "@deepseek-ai/schemastery";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Context } from "@deepseek-ai/cordis";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/at-rest.d.ts
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
/** Env override for the WorkBuddy desktop executable, for support and tests. */
declare const WORKBUDDY_APP_BINARY_ENV = "WORKBUDDY_APP_BINARY";
/** Thrown when the sealed fields cannot be opened locally. */
declare class WorkBuddyAtRestError extends Error {
  constructor(message: string);
}
/** One sealed field node as it appears in a WorkBuddy JSON document. */
interface WorkBuddySealedField {
  $wbEncrypted: 1;
  envelope: string;
}
/** Whether a JSON value is a sealed field node. */
declare function isSealedField(value: unknown): value is WorkBuddySealedField;
/**
 * The protector key the app derives for a build-key payload.
 *
 * The hash covers the *base64 text* of the secret, not its decoded bytes — that
 * detail is what makes the derivation match the app's `keyId`.
 */
declare function deriveProtectorKey(secretBase64: string): Buffer;
/** The app's key id for a derived key: `sha256(key).hex[0:16]`. */
declare function deriveKeyId(key: Buffer): string;
/** Which framing an envelope was sealed under. */
type EnvelopeFraming = 'file' | 'field';
/**
 * The GCM additional authenticated data the app builds for one envelope.
 *
 * Layout: `"WB-AAD\0" | 0x01 | u32len+"WBEF1"|"WBEV1" | u32len+"sym-v1" |
 * u32be(suite) | u32len+keyId | framingIndex | 0x00 | 0x00`.
 */
declare function envelopeAad(keyId: string, framing: EnvelopeFraming, suite: number): Buffer;
/**
 * Replace every sealed field in a parsed JSON document with its plaintext.
 *
 * Field envelopes are sealed with the protector key under the `field` framing,
 * not with the keyblob's master key — the keyblob only matters for the
 * `asym-v1` whole-file protection this plugin never needs.
 */
declare function openSealedFields<T>(document: T, key: Buffer): T;
/** Where the WorkBuddy desktop executable lives, in probe order. */
declare function defaultAppBinaryCandidates(): string[];
/**
 * Derive the protector key from the app's own binary.
 *
 * Single-flight and memoized: the secret is per-install and constant for the
 * lifetime of this process, so the probe runs at most once.
 */
declare function resolveProtectorKey(binaryOverride?: string): Promise<Buffer>;
/** Drop the memoized key; diagnostics and tests only. */
declare function resetProtectorKeyCache(): void;
/**
 * A document-level unlocker: sealed auth document in, plaintext document out.
 *
 * Throws {@link WorkBuddyAtRestError} with a human reason when the unlock is
 * unavailable, so the caller can report *why* the stored sign-in is unusable
 * instead of pretending nobody is signed in.
 */
type WorkBuddyAuthUnlocker = (text: string) => Promise<string>;
/** The default unlocker: derive the key from the app binary and open the fields. */
declare function createAtRestUnlocker(options?: {
  binary?: string;
}): WorkBuddyAuthUnlocker;
//#endregion
//#region src/upstream.d.ts
/** WorkBuddy region selected by the credential's login domain. */
type WorkBuddyRegion = 'cn' | 'global';
/** Upstream failure classes the shim maps onto distinct HTTP answers. */
type UpstreamErrorKind = 'hard_credit' | 'soft_rate' | 'session_dead' | 'not_found' | 'server' | 'client';
/** One CLI-usable model as the upstream catalog describes it. */
interface WorkBuddyUpstreamModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  /**
   * Upstream-declared image input capability. Missing or false upstream data
   * resolves to false, so an unknown model stays text-only: over-claiming
   * admits an image the provider then rejects after the message is durable.
   */
  supportsImages: boolean;
  /**
   * Reasoning metadata the upstream catalog declares per model. The wire
   * effort values (`low`, `medium`, `high`, `xhigh`, `max`) map directly onto
   * pi-ai's thinking levels, and the supported set decides which levels the
   * DSH model selector offers.
   */
  reasoning?: WorkBuddyModelReasoning;
  /**
   * Billing convenience metadata: the credits multiplier string the upstream
   * reports (e.g. `"x0.00"` for free) and promotional badges like
   * `badge:限时免费:#FF0000` or `badge:夜间折扣:#1E90FF`.
   *
   * The multiplier reaches the browser through the host LLM seam, which has no
   * locale service, so {@link normalizeCredits} trims it to a
   * language-neutral display form (`x0.79`) that reads the same in every UI
   * language. The raw upstream string (which may spell `x0.79 credits`) stays
   * on {@link WorkBuddyModelBilling.credits} for diagnostics.
   */
  billing?: WorkBuddyModelBilling;
}
/** Reasoning metadata the upstream catalog declares for one model. */
interface WorkBuddyModelReasoning {
  /** Whether the model does any reasoning at all (upstream `supportsReasoning`). */
  supports: boolean;
  /** Whether the model can only think (upstream `onlyReasoning`). */
  onlyReasoning: boolean;
  /** Selectable effort values; absent means the model has no explicit set. */
  supportedEfforts?: readonly WorkBuddyEffort[];
  /** Default effort the upstream uses when none is chosen. */
  defaultEffort?: WorkBuddyEffort;
  /**
   * Whether the model can be switched to non-thinking (upstream
   * `canDisableThinking`). Mirrored as an upstream fact; it does not gate the
   * offered effort ladder — the desktop app's own rule is
   * `!onlyReasoning && canDisableThinking !== false`, and switching thinking
   * off travels as *omitting* `reasoning_effort`, never as an undeclared wire
   * value (see `toPiModel` in adapter.ts).
   */
  canDisableThinking: boolean;
}
/**
 * The concrete effort spellings WorkBuddy exposes on the wire.
 *
 * `off` is part of the vocabulary (rank 0 in workbuddy2api's ladder) but is
 * *not* a universal switch: the upstream validates `reasoning_effort` against
 * each model's declared `supportedEfforts`, and every model observed so far
 * declares only thinking tiers. A declared `off` therefore travels as the
 * literal wire value; an undeclared one must never be manufactured.
 */
type WorkBuddyEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Billing convenience metadata reported for one model. */
interface WorkBuddyModelBilling {
  /** Credits multiplier, e.g. `"x0.00"` (free) or `"x0.79"`. */
  credits?: string;
  /** Promotional tags, e.g. `"限时免费"`, `"夜间折扣"`. */
  badges?: readonly string[];
  /** Whether the model is currently free (`x0.00` credits). */
  free: boolean;
}
/** One billing package and its remaining credit. */
interface WorkBuddyCreditAccount {
  packageName: string;
  remain: number;
  size: number;
}
/** Aggregated credit answer for one credential. */
interface WorkBuddyCredits {
  total: number;
  accounts: readonly WorkBuddyCreditAccount[];
}
/** Token refresh answer; fields the upstream omits stay absent. */
interface WorkBuddyRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  domain?: string;
}
/** Chat answer: either a live SSE response or a classified failure. */
type WorkBuddyChatResult = {
  ok: true;
  response: Response;
} | {
  ok: false;
  status: number;
  kind: UpstreamErrorKind;
  message: string;
};
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
declare function normalizeCredits(credits: string | undefined): string | undefined;
/** Classify an upstream failure from its HTTP status and body excerpt. */
declare function classifyUpstreamError(status: number, body: string): UpstreamErrorKind;
/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
declare function regionOf(domain: string): WorkBuddyRegion;
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
declare function prepareChatBody(source: string): string;
/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take
 * the credential explicitly so token refreshes apply on the next call.
 */
declare class WorkBuddyUpstreamClient {
  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  chatStream(credential: WorkBuddyCredential, bodyJson: string, signal?: AbortSignal): Promise<WorkBuddyChatResult>;
  /** POST the token-refresh endpoint; the caller merges the outcome. */
  refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome>;
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
  fetchModels(): Promise<readonly WorkBuddyUpstreamModel[]>;
  /** POST the billing endpoint for the aggregated remaining credit. */
  fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits>;
}
//#endregion
//#region src/auth.d.ts
/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
interface WorkBuddyCredential {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  domain: string;
  uid: string;
  enterpriseId?: string;
  nickname?: string;
  /** Which storage the credential was read from; refreshes are always `dsh`. */
  source: 'desktop' | 'desktop-unlocked' | 'dsh';
}
/** Read-only sign-in summary for status and doctor output. */
interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out';
  expiresAtMs?: number;
  refreshExpiresAtMs?: number;
  nickname?: string;
  domain?: string;
  source?: 'desktop' | 'desktop-unlocked' | 'dsh';
  /**
   * Why no credential is usable, when the reason is diagnosable rather than
   * "nobody is signed in" — the desktop app sealing the credential at rest
   * being the case that matters. Present only on `signed-out`.
   */
  reason?: string;
}
/** Constructor options; only {@link refresh} is required. */
interface WorkBuddyStoreOptions {
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string;
  /** Explicit plugin-owned copy path, defaulting under `$DSH_HOME`. */
  ownPath?: string;
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>;
  /**
   * Opens a sign-in the desktop app sealed at rest. Defaults to the real
   * unlocker, which derives the protector key from the WorkBuddy desktop
   * binary; injected in tests so no process is ever spawned.
   */
  unlock?: WorkBuddyAuthUnlocker;
  /**
   * Optional sink for the one-line notice emitted the first time a sealed
   * sign-in is opened, so the host log records that it happened.
   */
  logger?: {
    info(message: string): void;
  };
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number;
}
/** Basename of the plugin-owned credential copy inside the Harness home. */
declare const WORKBUDDY_AUTH_FILENAME = ".workbuddy-auth.json";
/** Env variable that overrides the desktop auth-file location. */
declare const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
/** Plugin-owned copy path inside the Harness home. */
declare function workbuddyOwnAuthPath(): string;
/**
 * Platform-default candidates for the WorkBuddy desktop app's auth file, in
 * probe order. Windows probes both AppData roots: current builds write under
 * `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%` (Roaming). WSL probes
 * those same Windows locations through its mounted Windows profile before the
 * native Linux location.
 */
declare function defaultDesktopAuthCandidates(): string[];
/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
declare function defaultDesktopAuthPath(): string | undefined;
/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
declare function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined;
/** How a desktop auth document stores its tokens. */
type WorkBuddyAuthTokenShape =
/** A plain string the plugin can use. */
'plaintext' |
/** Sealed in a `$wbEncrypted` envelope the plugin cannot open. */
'encrypted-at-rest' |
/** Parsed fine, but carries no access token at all. */
'no-token' |
/** Not a JSON object this parser recognizes. */
'unparsable';
/**
 * Why {@link parseWorkBuddyAuth} would reject a document.
 *
 * The distinction is the whole point: "nobody is signed in" and "signed in,
 * but the app sealed the token" are different problems with different fixes,
 * and collapsing both into signed-out makes the second look like a bad key.
 */
declare function inspectWorkBuddyAuthDocument(text: string): WorkBuddyAuthTokenShape;
/** `code` carried by a credential the plugin cannot read; the shim routes on it. */
declare const WORKBUDDY_CREDENTIAL_UNREADABLE_CODE = "credential_unreadable";
/** Human-facing reason an otherwise valid sign-in is unusable here. */
declare const WORKBUDDY_ENCRYPTED_AT_REST_REASON: string;
/**
 * Thrown when the desktop app holds a valid sign-in the plugin cannot read.
 *
 * Deliberately not an ordinary "not signed in" failure: the credential file is
 * intact and the user's session is fine. A caller that reports this as an
 * authentication error makes the Harness render "API 密钥无效" / "API key is
 * invalid", which is the wrong diagnosis and hides the real fix.
 */
declare class WorkBuddyCredentialUnreadableError extends Error {
  readonly code = "credential_unreadable";
  constructor(message: string);
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
declare class WorkBuddyCredentialStore {
  private readonly refresh;
  private readonly unlock;
  private readonly logger;
  private readonly refreshMarginMs;
  private readonly ownPath;
  private desktopPathOverride;
  private inflight;
  /** Shape of the last desktop file read, for diagnosable signed-out states. */
  private desktopDiagnosis;
  /** Why the last at-rest unlock attempt failed, when it did. */
  private unlockFailure;
  /** Whether the one-line unlock notice has been logged. */
  private unlockLogged;
  constructor(options: WorkBuddyStoreOptions);
  /**
   * Configuration precedence for the desktop file: the plugin's configured
   * path, then the environment variable, then the platform defaults. An
   * explicit path is used verbatim; the defaults are a probe order.
   */
  private resolveDesktopCandidates;
  private resolveDesktopPath;
  /**
   * Repoint the desktop file; a settings change applies on the next read.
   */
  setDesktopPath(path: string | undefined): void;
  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined;
  /** The plugin-owned copy path, for diagnostics. */
  ownAuthPath(): string;
  /** Read the freshest stored credential without refreshing anything. */
  current(): Promise<WorkBuddyCredential | undefined>;
  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  resolve(): Promise<WorkBuddyCredential>;
  /**
   * Why the stored sign-in is unusable, when the last desktop read could tell.
   *
   * Only the encrypted-at-rest shape is reported: every other rejection keeps
   * the long-standing "nobody is signed in" wording, which is accurate for an
   * absent or token-less file. When the local unlock failed, its reason is
   * carried too — that is the difference between "we cannot open this" and
   * "your key is wrong".
   */
  private unreadableReason;
  /** Read-only sign-in summary; never refreshes and never throws. */
  status(): Promise<WorkBuddyAuthStatus>;
  /** Remove the plugin-owned copy; the desktop file is untouched. */
  logout(): Promise<void>;
  private needsRefresh;
  private refreshNow;
  private saveOwn;
  /**
   * Read the first desktop candidate that exists. Only an absent file
   * (ENOENT) falls through to the next candidate; a file that is present
   * but unparsable is authoritative for its slot, so a stale older-version
   * file never silently wins over a broken newer one.
   */
  private readDesktop;
  /**
   * Open a sealed sign-in with the local unlocker.
   *
   * A failure is recorded rather than thrown: the caller reports it as the
   * reason the stored sign-in is unusable — accurate and actionable — while the
   * next read retries, so a transient probe failure never sticks.
   */
  private unlockSealed;
  private readOwn;
  /** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
  desktopFilePresent(): Promise<boolean>;
}
//#endregion
//#region src/catalog.d.ts
/** One model entry the adapter exposes. */
type WorkBuddyModelInfo = WorkBuddyUpstreamModel;
/**
 * A static CLI-model list captured from the CN endpoint (re-verified against
 * the live catalog 2026-09-01). It is kept for diagnostics and as a public
 * export only: the runtime catalog no longer initializes from it. The model
 * directory now comes exclusively from the desktop app's local product-config
 * cache, so an unreadable cache yields an empty catalog — never this stale
 * list.
 */
declare const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[];
/** Mutable catalog shared by the shim's `/v1/models` and the adapter. */
declare class WorkBuddyCatalog {
  private models;
  /**
   * Current entries. The catalog starts empty and is populated once the local
   * product-config cache loads; a cache miss keeps it empty rather than
   * serving the static fallback list, so the picker never shows stale models.
   */
  current(): readonly WorkBuddyModelInfo[];
  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly WorkBuddyModelInfo[]): void;
}
//#endregion
//#region src/shim.d.ts
/** Minimal logger surface the plugin context already provides. */
interface ShimLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
/** What the plugin needs from a running shim. */
interface WorkBuddyShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>;
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string;
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this instead of the upstream access token, because the shim
   * resolves the real credential itself via the store.
   */
  token(): string;
  /** Stop serving and destroy open connections. */
  close(): Promise<void>;
}
/** Constructor dependencies. */
interface WorkBuddyShimOptions {
  store: WorkBuddyCredentialStore;
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>;
  catalog: WorkBuddyCatalog;
  logger?: ShimLogger;
}
/**
 * Start the loopback endpoint. Requests carry any bearer; the loopback bind
 * is the boundary, and the upstream credential comes from the store alone.
 */
declare function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim;
//#endregion
//#region src/adapter.d.ts
/** Provider route this bundle owns. */
declare const WORKBUDDY_PROVIDER = "workbuddy-oo";
/** Provider idle ceiling while one stream read is outstanding. */
declare const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Constructor dependencies. */
interface WorkBuddyAdapterOptions {
  shim: WorkBuddyShim;
  store: WorkBuddyCredentialStore;
  catalog: WorkBuddyCatalog;
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined;
}
/** What {@link createWorkBuddyAdapter} hands back. */
interface WorkBuddyAdapter {
  adapter: PiAiAdapter;
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void;
}
/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 */
declare function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter;
//#endregion
//#region src/host-heartbeat.d.ts
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
declare const WORKBUDDY_HOST_HEARTBEAT_FILENAME = ".workbuddy-host-heartbeat.json";
/** Current on-disk heartbeat format; readers reject others. */
declare const HEARTBEAT_FORMAT_VERSION = 1;
/** On-disk shape of the heartbeat. */
interface WorkBuddyHostHeartbeat {
  version: typeof HEARTBEAT_FORMAT_VERSION;
  package: 'dsh-workbuddy-connect-oo';
  pluginVersion: string;
  /** Epoch milliseconds when the host registered the provider. */
  registeredAt: number;
  /** Host process PID, to distinguish a stale heartbeat after a crash. */
  pid: number;
}
/** Absolute path of the host heartbeat file. */
declare function workbuddyHostHeartbeatPath(): string;
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
declare function clearHostHeartbeat(): Promise<void>;
/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
declare function readHostHeartbeat(): Promise<WorkBuddyHostHeartbeat | undefined>;
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
declare function processStartTimeMs(pid: number): number | undefined;
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
declare function isHeartbeatProcessAlive(heartbeat: WorkBuddyHostHeartbeat): boolean;
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name. */
declare const name = "llm-workbuddy-connect-oo";
/** The model registry required before the provider can register. */
declare const inject: string[];
/**
 * Settings namespace reserved for the configuration card.
 *
 * A bare string since `dsh-settings` 0.1.2-alpha.5 dropped the
 * `settingsNamespace()` brand factory; the namespace stays a nominal
 * `SettingsNamespace` at the type level so provider/directory joins and the
 * settings descriptors keep comparing by identity.
 */
declare const WORKBUDDY_SETTINGS_NS: SettingsNamespace;
/** Plugin configuration. */
interface Config {
  /** Explicit WorkBuddy desktop auth-file path, overriding env and platform defaults. */
  authFile?: string;
}
declare const Config: z<Config>;
/**
 * Start the loopback endpoint, register the `workbuddy` provider, and load
 * the model catalog from the desktop app's local product-config cache before
 * registration. A cache miss leaves the catalog empty (no network or static
 * fallback), so the picker never shows a stale model list.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, FALLBACK_WORKBUDDY_MODELS, type UpstreamErrorKind, WORKBUDDY_APP_BINARY_ENV, WORKBUDDY_AUTH_FILENAME, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_CREDENTIAL_UNREADABLE_CODE, WORKBUDDY_ENCRYPTED_AT_REST_REASON, WORKBUDDY_HOST_HEARTBEAT_FILENAME, WORKBUDDY_PROVIDER, WORKBUDDY_SETTINGS_NS, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, type WorkBuddyAdapter, WorkBuddyAtRestError, type WorkBuddyAuthStatus, type WorkBuddyAuthTokenShape, type WorkBuddyAuthUnlocker, WorkBuddyCatalog, type WorkBuddyChatResult, type WorkBuddyCredential, WorkBuddyCredentialStore, WorkBuddyCredentialUnreadableError, type WorkBuddyCredits, type WorkBuddyEffort, type WorkBuddyHostHeartbeat, type WorkBuddyModelBilling, type WorkBuddyModelInfo, type WorkBuddyModelReasoning, type WorkBuddyRefreshOutcome, type WorkBuddySealedField, type WorkBuddyShim, WorkBuddyUpstreamClient, type WorkBuddyUpstreamModel, apply, classifyUpstreamError, clearHostHeartbeat, createAtRestUnlocker, createWorkBuddyAdapter, createWorkBuddyShim, defaultAppBinaryCandidates, defaultDesktopAuthCandidates, defaultDesktopAuthPath, deriveKeyId, deriveProtectorKey, envelopeAad, inject, inspectWorkBuddyAuthDocument, isSealedField as isEncryptedFieldWrapper, isSealedField, isHeartbeatProcessAlive, name, normalizeCredits, openSealedFields, parseWorkBuddyAuth, prepareChatBody, processStartTimeMs, readHostHeartbeat, regionOf, resetProtectorKeyCache, resolveProtectorKey, workbuddyHostHeartbeatPath, workbuddyOwnAuthPath };