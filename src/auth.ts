/**
 * WorkBuddy credential resolution. The primary source is the WorkBuddy
 * desktop app's own auth file, read-only; a plugin-owned copy under
 * `$DSH_HOME` holds token refreshes so the desktop file is never written.
 * The effective credential is whichever of the two expires later, so a
 * refresh by either side wins.
 *
 * @module dsh-workbuddy-connect/auth
 */

import { readFile, rm, stat } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { basename, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createAtRestUnlocker, isSealedField, type WorkBuddyAuthUnlocker } from './at-rest.ts'
import type { WorkBuddyRefreshOutcome } from './upstream.ts'

/** Whether a value is the desktop app's `$wbEncrypted` field wrapper. */
export { isSealedField as isEncryptedFieldWrapper } from './at-rest.ts'

/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
  /** Which storage the credential was read from; refreshes are always `dsh`. */
  source: 'desktop' | 'desktop-unlocked' | 'dsh'
}

/** Read-only sign-in summary for status and doctor output. */
export interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out'
  expiresAtMs?: number
  refreshExpiresAtMs?: number
  nickname?: string
  domain?: string
  source?: 'desktop' | 'desktop-unlocked' | 'dsh'
  /**
   * Why no credential is usable, when the reason is diagnosable rather than
   * "nobody is signed in" — the desktop app sealing the credential at rest
   * being the case that matters. Present only on `signed-out`.
   */
  reason?: string
}

/** Constructor options; only {@link refresh} is required. */
export interface WorkBuddyStoreOptions {
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string
  /** Explicit plugin-owned copy path, defaulting under `$DSH_HOME`. */
  ownPath?: string
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  /**
   * Opens a sign-in the desktop app sealed at rest. Defaults to the real
   * unlocker, which derives the protector key from the WorkBuddy desktop
   * binary; injected in tests so no process is ever spawned.
   */
  unlock?: WorkBuddyAuthUnlocker
  /**
   * Optional sink for the one-line notice emitted the first time a sealed
   * sign-in is opened, so the host log records that it happened.
   */
  logger?: { info(message: string): void }
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
}

/** Basename of the plugin-owned credential copy inside the Harness home. */
export const WORKBUDDY_AUTH_FILENAME = '.workbuddy-auth.json'

/** Env variable that overrides the desktop auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1

interface OwnDocument {
  version: typeof OWN_FORMAT_VERSION
  credential: WorkBuddyCredential
}

/** Plugin-owned copy path inside the Harness home. */
export function workbuddyOwnAuthPath(): string {
  return join(resolveDshHome(), WORKBUDDY_AUTH_FILENAME)
}

const DESKTOP_AUTH_RELATIVE_PATH = ['CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'] as const

/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env['WSL_DISTRO_NAME'] !== undefined || process.env['WSL_INTEROP'] !== undefined) return true
  return release().toLowerCase().includes('microsoft')
}

/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl(value: string | undefined): string | undefined {
  const path = value?.trim()
  if (!path) return undefined
  if (path.startsWith('/')) return path
  const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path)
  if (drivePath === null) return undefined
  return join('/mnt', drivePath[1]!.toLowerCase(), ...drivePath[2]!.split(/[\\/]+/u))
}

/** Windows desktop credential candidates visible from a WSL process. */
function wslDesktopAuthCandidates(home: string): string[] {
  const profile = windowsPathForWsl(process.env['USERPROFILE'])
    ?? join('/mnt/c/Users', basename(home))
  const localAppData = windowsPathForWsl(process.env['LOCALAPPDATA'])
    ?? join(profile, 'AppData', 'Local')
  const roamingAppData = windowsPathForWsl(process.env['APPDATA'])
    ?? join(profile, 'AppData', 'Roaming')
  return [
    join(localAppData, ...DESKTOP_AUTH_RELATIVE_PATH),
    join(roamingAppData, ...DESKTOP_AUTH_RELATIVE_PATH),
  ]
}

/**
 * Platform-default candidates for the WorkBuddy desktop app's auth file, in
 * probe order. Windows probes both AppData roots: current builds write under
 * `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%` (Roaming). WSL probes
 * those same Windows locations through its mounted Windows profile before the
 * native Linux location.
 */
export function defaultDesktopAuthCandidates(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')]
  }
  if (process.platform === 'win32') {
    return [
      join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
      join(home, 'AppData', 'Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    ]
  }
  if (process.platform === 'linux') {
    const linux = join(home, '.config', ...DESKTOP_AUTH_RELATIVE_PATH)
    return isWsl() ? [...wslDesktopAuthCandidates(home), linux] : [linux]
  }
  return []
}

/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
export function defaultDesktopAuthPath(): string | undefined {
  return defaultDesktopAuthCandidates()[0]
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
export function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    identity = typeof document['account'] === 'object' && document['account'] !== null
      ? document['account'] as Record<string, unknown>
      : {}
  } else {
    auth = document
    identity = document
  }
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') return undefined
  const expiresAtMs = typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0
  const refreshExpiresAtMs = typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  const enterpriseId = optionalString(identity['enterpriseId'])
  const nickname = optionalString(identity['nickname'])
  const credential: WorkBuddyCredential = {
    accessToken,
    refreshToken: typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] : '',
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(auth['domain']) ?? '',
    uid: optionalString(identity['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'desktop',
  }
  return credential
}

/** How a desktop auth document stores its tokens. */
export type WorkBuddyAuthTokenShape =
  /** A plain string the plugin can use. */
  | 'plaintext'
  /** Sealed in a `$wbEncrypted` envelope the plugin cannot open. */
  | 'encrypted-at-rest'
  /** Parsed fine, but carries no access token at all. */
  | 'no-token'
  /** Not a JSON object this parser recognizes. */
  | 'unparsable'

/**
 * Why {@link parseWorkBuddyAuth} would reject a document.
 *
 * The distinction is the whole point: "nobody is signed in" and "signed in,
 * but the app sealed the token" are different problems with different fixes,
 * and collapsing both into signed-out makes the second look like a bad key.
 */
export function inspectWorkBuddyAuthDocument(text: string): WorkBuddyAuthTokenShape {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'unparsable'
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unparsable'
  const document = parsed as Record<string, unknown>
  const auth = typeof document['auth'] === 'object' && document['auth'] !== null
    ? document['auth'] as Record<string, unknown>
    : document
  if (typeof auth['accessToken'] === 'string' && auth['accessToken'] !== '') return 'plaintext'
  if (isSealedField(auth['accessToken']) || isSealedField(auth['refreshToken'])) {
    return 'encrypted-at-rest'
  }
  return 'no-token'
}

/** `code` carried by a credential the plugin cannot read; the shim routes on it. */
export const WORKBUDDY_CREDENTIAL_UNREADABLE_CODE = 'credential_unreadable'

/** Human-facing reason an otherwise valid sign-in is unusable here. */
export const WORKBUDDY_ENCRYPTED_AT_REST_REASON =
  'the WorkBuddy desktop app sealed its stored sign-in with at-rest encryption'
  + ' (a `$wbEncrypted` envelope, app 5.6.0+)'

/**
 * Thrown when the desktop app holds a valid sign-in the plugin cannot read.
 *
 * Deliberately not an ordinary "not signed in" failure: the credential file is
 * intact and the user's session is fine. A caller that reports this as an
 * authentication error makes the Harness render "API 密钥无效" / "API key is
 * invalid", which is the wrong diagnosis and hides the real fix.
 */
export class WorkBuddyCredentialUnreadableError extends Error {
  readonly code = WORKBUDDY_CREDENTIAL_UNREADABLE_CODE
  constructor(message: string) {
    super(message)
    this.name = 'WorkBuddyCredentialUnreadableError'
  }
}

/** Serialize the plugin-owned copy. */
function ownDocument(credential: WorkBuddyCredential): OwnDocument {
  return { version: OWN_FORMAT_VERSION, credential }
}

/** Parse the plugin-owned copy; other versions and shapes are rejected. */
function parseOwnDocument(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document['version'] !== OWN_FORMAT_VERSION) return undefined
  if (typeof document['credential'] !== 'object' || document['credential'] === null) return undefined
  // The owned copy stores the normalized credential itself (camelCase
  // `expiresAtMs`, identity fields at the top level), not the desktop
  // document shape. Round-tripping it through parseWorkBuddyAuth reads
  // `expiresAt` and an `account` object, finds neither, zeroes the expiry,
  // and drops uid/enterprise/nickname — so a surviving copy refreshed on
  // every request. Read the stored shape directly instead.
  const stored = document['credential'] as Record<string, unknown>
  const accessToken = typeof stored['accessToken'] === 'string' ? stored['accessToken'] : ''
  if (accessToken === '') return undefined
  const refreshExpiresAtMs = typeof stored['refreshExpiresAtMs'] === 'number' ? stored['refreshExpiresAtMs'] : undefined
  const enterpriseId = optionalString(stored['enterpriseId'])
  const nickname = optionalString(stored['nickname'])
  return {
    accessToken,
    refreshToken: typeof stored['refreshToken'] === 'string' ? stored['refreshToken'] : '',
    expiresAtMs: typeof stored['expiresAtMs'] === 'number' ? stored['expiresAtMs'] : 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(stored['domain']) ?? '',
    uid: optionalString(stored['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'dsh',
  }
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
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
export class WorkBuddyCredentialStore {
  private readonly refresh: WorkBuddyStoreOptions['refresh']
  private readonly unlock: WorkBuddyAuthUnlocker
  private readonly logger: WorkBuddyStoreOptions['logger']
  private readonly refreshMarginMs: number
  private readonly ownPath: string
  private desktopPathOverride: string | undefined
  private inflight: Promise<WorkBuddyCredential> | undefined
  /** Shape of the last desktop file read, for diagnosable signed-out states. */
  private desktopDiagnosis: WorkBuddyAuthTokenShape | undefined
  /** Why the last at-rest unlock attempt failed, when it did. */
  private unlockFailure: string | undefined
  /** Whether the one-line unlock notice has been logged. */
  private unlockLogged = false

  constructor(options: WorkBuddyStoreOptions) {
    this.refresh = options.refresh
    this.unlock = options.unlock ?? createAtRestUnlocker()
    this.logger = options.logger
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.ownPath = options.ownPath ?? workbuddyOwnAuthPath()
    this.desktopPathOverride = options.desktopPath
  }

  /**
   * Configuration precedence for the desktop file: the plugin's configured
   * path, then the environment variable, then the platform defaults. An
   * explicit path is used verbatim; the defaults are a probe order.
   */
  private resolveDesktopCandidates(): string[] {
    const fromEnv = process.env[WORKBUDDY_AUTH_FILE_ENV]
    const explicit = this.desktopPathOverride
      ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    if (explicit !== undefined) return [explicit]
    return defaultDesktopAuthCandidates()
  }

  private resolveDesktopPath(): string | undefined {
    return this.resolveDesktopCandidates()[0]
  }

  /**
   * Repoint the desktop file; a settings change applies on the next read.
   */
  setDesktopPath(path: string | undefined): void {
    this.desktopPathOverride = path
  }

  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined {
    return this.resolveDesktopPath()
  }

  /** The plugin-owned copy path, for diagnostics. */
  ownAuthPath(): string {
    return this.ownPath
  }

  /** Read the freshest stored credential without refreshing anything. */
  async current(): Promise<WorkBuddyCredential | undefined> {
    const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()])
    if (desktop === undefined) return own
    if (own === undefined) return desktop
    return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
  }

  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  async resolve(): Promise<WorkBuddyCredential> {
    const credential = await this.current()
    if (credential === undefined) {
      // A sign-in the app sealed at rest is a local format gap, not an auth
      // failure: throwing it as one would surface "API key is invalid".
      const unreadable = this.unreadableReason()
      if (unreadable !== undefined) throw new WorkBuddyCredentialUnreadableError(`workbuddy: ${unreadable}`)
      const candidates = this.resolveDesktopCandidates()
      const desktop = candidates.length > 0 ? candidates.join(' or ') : '(no desktop path on this platform)'
      throw new Error(
        `workbuddy: no signed-in WorkBuddy account found; sign in once in the WorkBuddy desktop app`
        + ` (expected ${desktop} or WORKBUDDY_AUTH_FILE), or refresh an existing session`,
      )
    }
    if (!this.needsRefresh(credential)) return credential
    this.inflight ??= this.refreshNow(credential)
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
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
  private unreadableReason(): string | undefined {
    if (this.desktopDiagnosis !== 'encrypted-at-rest') return undefined
    const path = this.resolveDesktopPath() ?? '(unresolved)'
    const outcome = this.unlockFailure === undefined
      ? `the sealed sign-in file at ${path} could not be read`
      : `unlocking it locally failed (${this.unlockFailure})`
    return `${WORKBUDDY_ENCRYPTED_AT_REST_REASON}; ${outcome}, so keep the desktop app signed in`
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async status(): Promise<WorkBuddyAuthStatus> {
    try {
      const credential = await this.current()
      if (credential === undefined) {
        const reason = this.unreadableReason()
        return reason === undefined ? { state: 'signed-out' } : { state: 'signed-out', reason }
      }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        ...credential.domain === '' ? {} : { domain: credential.domain },
        source: credential.source,
      }
    } catch (error: unknown) {
      // An unreadable file is a diagnosable signed-out state, not a silent
      // one: the reading error is what tells the user which file to fix.
      return { state: 'signed-out', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Remove the plugin-owned copy; the desktop file is untouched. */
  async logout(): Promise<void> {
    await rm(this.ownPath, { force: true })
    await rm(`${this.ownPath}.lock`, { force: true })
  }

  private needsRefresh(credential: WorkBuddyCredential): boolean {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  private async refreshNow(credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('workbuddy: access token expired and no refresh token is stored; sign in again in the WorkBuddy desktop app')
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed: WorkBuddyCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresInSec !== undefined
          ? Date.now() + outcome.expiresInSec * 1000
          : credential.expiresAtMs,
        ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
        source: 'dsh',
      }
      await this.saveOwn(refreshed)
      return refreshed
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        `workbuddy: token refresh failed and the access token is expired (${String(error)});`
        + ' open the WorkBuddy desktop app once to sign in again',
      )
    }
  }

  private async saveOwn(credential: WorkBuddyCredential): Promise<void> {
    await withFileLock(this.ownPath, async () => {
      await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }

  /**
   * Read the first desktop candidate that exists. Only an absent file
   * (ENOENT) falls through to the next candidate; a file that is present
   * but unparsable is authoritative for its slot, so a stale older-version
   * file never silently wins over a broken newer one.
   */
  private async readDesktop(): Promise<WorkBuddyCredential | undefined> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      try {
        const text = await readFile(desktopPath, 'utf8')
        const credential = parseWorkBuddyAuth(text)
        if (credential !== undefined) {
          this.desktopDiagnosis = undefined
          this.unlockFailure = undefined
          return credential
        }
        // Remember why an existing file yielded nothing, so status/resolve can
        // say "sealed at rest" rather than "nobody is signed in".
        this.desktopDiagnosis = inspectWorkBuddyAuthDocument(text)
        if (this.desktopDiagnosis === 'encrypted-at-rest') return await this.unlockSealed(text)
        return undefined
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
      }
    }
    this.desktopDiagnosis = undefined
    this.unlockFailure = undefined
    return undefined
  }

  /**
   * Open a sealed sign-in with the local unlocker.
   *
   * A failure is recorded rather than thrown: the caller reports it as the
   * reason the stored sign-in is unusable — accurate and actionable — while the
   * next read retries, so a transient probe failure never sticks.
   */
  private async unlockSealed(text: string): Promise<WorkBuddyCredential | undefined> {
    try {
      const recovered = parseWorkBuddyAuth(await this.unlock(text))
      if (recovered === undefined) {
        this.unlockFailure = 'the unlocked document carried no access token'
        return undefined
      }
      this.unlockFailure = undefined
      if (!this.unlockLogged) {
        this.unlockLogged = true
        this.logger?.info(
          'dsh-workbuddy-connect: opened the WorkBuddy desktop sign-in by unlocking its at-rest envelope locally'
          + ' (the app\'s Electron binary supplied the protector key; nothing was sent anywhere)',
        )
      }
      return { ...recovered, source: 'desktop-unlocked' }
    } catch (error: unknown) {
      this.unlockFailure = error instanceof Error ? error.message : String(error)
      return undefined
    }
  }

  private async readOwn(): Promise<WorkBuddyCredential | undefined> {
    try {
      return parseOwnDocument(await readFile(this.ownPath, 'utf8'))
    } catch (error: unknown) {
      if (isENOENT(error)) return undefined
      return undefined
    }
  }

  /** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
  async desktopFilePresent(): Promise<boolean> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      try {
        if ((await stat(desktopPath)).isFile()) return true
      } catch {
        // absent or not a regular file — try the next candidate
      }
    }
    return false
  }
}
