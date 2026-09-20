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

import { createDecipheriv, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Env override for the WorkBuddy desktop executable, for support and tests. */
export const WORKBUDDY_APP_BINARY_ENV = 'WORKBUDDY_APP_BINARY'

/** How long the accessor probe may take before the unlock is given up on. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * The in-process probe. It prints `loggerGet()`'s JSON verbatim on stdout; the
 * parent parses it. No shell is involved (`execFile` with an argv array), so the
 * source needs no quoting beyond being one argument.
 */
const ACCESSOR_PROBE =
  'process.stdout.write(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet())'

/** Thrown when the sealed fields cannot be opened locally. */
export class WorkBuddyAtRestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkBuddyAtRestError'
  }
}

/** One sealed field node as it appears in a WorkBuddy JSON document. */
export interface WorkBuddySealedField {
  $wbEncrypted: 1
  envelope: string
}

/** The decoded envelope behind a sealed field. */
interface Envelope {
  suite: number
  keyId: string
  nonce: string
  authTag: string
  ciphertext: string
}

/** Whether a JSON value is a sealed field node. */
export function isSealedField(value: unknown): value is WorkBuddySealedField {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record['$wbEncrypted'] === 1 && typeof record['envelope'] === 'string'
}

/** The app's payload shape from the accessor's `loggerGet()`. */
interface BuildKeyPayload {
  version: number
  atRestSecretKey: string
}

/**
 * The protector key the app derives for a build-key payload.
 *
 * The hash covers the *base64 text* of the secret, not its decoded bytes — that
 * detail is what makes the derivation match the app's `keyId`.
 */
export function deriveProtectorKey(secretBase64: string): Buffer {
  return createHash('sha256').update(Buffer.from(secretBase64, 'utf8')).digest()
}

/** The app's key id for a derived key: `sha256(key).hex[0:16]`. */
export function deriveKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** Which framing an envelope was sealed under. */
type EnvelopeFraming = 'file' | 'field'

const FRAMINGS: Readonly<Record<EnvelopeFraming, { label: string, index: number }>> = {
  file: { label: 'WBEF1', index: 1 },
  field: { label: 'WBEV1', index: 2 },
}

/** Big-endian u32 length prefix, the app's framing primitive. */
function lengthPrefixed(value: string): Buffer {
  const body = Buffer.from(value, 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  return Buffer.concat([length, body])
}

/**
 * The GCM additional authenticated data the app builds for one envelope.
 *
 * Layout: `"WB-AAD\0" | 0x01 | u32len+"WBEF1"|"WBEV1" | u32len+"sym-v1" |
 * u32be(suite) | u32len+keyId | framingIndex | 0x00 | 0x00`.
 */
export function envelopeAad(keyId: string, framing: EnvelopeFraming, suite: number): Buffer {
  const { label, index } = FRAMINGS[framing]
  const suiteField = Buffer.alloc(4)
  suiteField.writeUInt32BE(suite, 0)
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lengthPrefixed(label),
    lengthPrefixed('sym-v1'),
    suiteField,
    lengthPrefixed(keyId),
    Buffer.from([index, 0, 0]),
  ])
}

/** Decode one sealed field's envelope JSON. */
function decodeEnvelope(node: WorkBuddySealedField): Envelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(node.envelope, 'base64').toString('utf8'))
  } catch {
    throw new WorkBuddyAtRestError('a sealed field does not carry a decodable envelope')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WorkBuddyAtRestError('a sealed field envelope is not an object')
  }
  const envelope = parsed as Record<string, unknown>
  const required = ['suite', 'keyId', 'nonce', 'authTag', 'ciphertext'] as const
  for (const field of required) {
    const value = envelope[field]
    if (typeof value !== 'string' && !(field === 'suite' && typeof value === 'number')) {
      throw new WorkBuddyAtRestError(`a sealed field envelope is missing ${field}`)
    }
  }
  if (envelope['suite'] !== 1) {
    throw new WorkBuddyAtRestError(`unsupported at-rest envelope suite ${String(envelope['suite'])}`)
  }
  return {
    suite: envelope['suite'] as number,
    keyId: envelope['keyId'] as string,
    nonce: envelope['nonce'] as string,
    authTag: envelope['authTag'] as string,
    ciphertext: envelope['ciphertext'] as string,
  }
}

/** Open one sealed field. */
function openSealedField(node: WorkBuddySealedField, key: Buffer, framing: EnvelopeFraming): string {
  const envelope = decodeEnvelope(node)
  if (envelope.keyId !== deriveKeyId(key)) {
    throw new WorkBuddyAtRestError('a sealed field was sealed with a different key than the one derived')
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'), { authTagLength: 16 })
    decipher.setAAD(envelopeAad(envelope.keyId, framing, envelope.suite))
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch (error: unknown) {
    throw new WorkBuddyAtRestError(`a sealed field failed to decrypt (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * Replace every sealed field in a parsed JSON document with its plaintext.
 *
 * Field envelopes are sealed with the protector key under the `field` framing,
 * not with the keyblob's master key — the keyblob only matters for the
 * `asym-v1` whole-file protection this plugin never needs.
 */
export function openSealedFields<T>(document: T, key: Buffer): T {
  const walk = (value: unknown): unknown => {
    if (isSealedField(value)) return openSealedField(value, key, 'field')
    if (Array.isArray(value)) return value.map(walk)
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]))
    }
    return value
  }
  return walk(document) as T
}

/** Where the WorkBuddy desktop executable lives, in probe order. */
export function defaultAppBinaryCandidates(): string[] {
  const fromEnv = process.env[WORKBUDDY_APP_BINARY_ENV]?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return [fromEnv]
  if (process.platform !== 'darwin') return []
  const app = join('Contents', 'MacOS', 'Electron')
  return [
    join('/Applications', 'WorkBuddy.app', app),
    join(homedir(), 'Applications', 'WorkBuddy.app', app),
  ]
}

/** Reads the build-key payload out of the app binary (memoized per process). */
let cachedProtectorKey: Promise<Buffer> | undefined

/**
 * Derive the protector key from the app's own binary.
 *
 * Single-flight and memoized: the secret is per-install and constant for the
 * lifetime of this process, so the probe runs at most once.
 */
export function resolveProtectorKey(binaryOverride?: string): Promise<Buffer> {
  cachedProtectorKey ??= deriveFromAppBinary(binaryOverride).catch((error: unknown) => {
    // A failure must not pin the process to a broken state: a transient probe
    // failure (app being updated, process table pressure) should be retryable.
    cachedProtectorKey = undefined
    throw error
  })
  return cachedProtectorKey
}

/** Drop the memoized key; diagnostics and tests only. */
export function resetProtectorKeyCache(): void {
  cachedProtectorKey = undefined
}

async function deriveFromAppBinary(binaryOverride?: string): Promise<Buffer> {
  const candidates = binaryOverride === undefined ? defaultAppBinaryCandidates() : [binaryOverride]
  if (candidates.length === 0) {
    throw new WorkBuddyAtRestError(`no WorkBuddy desktop binary is known on ${process.platform}`)
  }
  let lastError: unknown
  for (const binary of candidates) {
    try {
      const { stdout } = await run(binary, ['-e', ACCESSOR_PROBE], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 1 << 20,
      })
      return protectorKeyFromProbe(stdout)
    } catch (error: unknown) {
      lastError = error
    }
  }
  throw new WorkBuddyAtRestError(
    `the WorkBuddy desktop binary could not be read for the at-rest key (${lastError instanceof Error ? lastError.message : String(lastError)})`,
  )
}

/** Parse the probe's stdout and derive the key; exported for tests. */
export function protectorKeyFromProbe(stdout: string): Buffer {
  let payload: unknown
  try {
    payload = JSON.parse(stdout)
  } catch {
    throw new WorkBuddyAtRestError('the WorkBuddy at-rest accessor did not return JSON')
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new WorkBuddyAtRestError('the WorkBuddy at-rest accessor returned an unexpected payload')
  }
  const candidate = payload as Partial<BuildKeyPayload>
  if (candidate.version !== 1 || typeof candidate.atRestSecretKey !== 'string' || candidate.atRestSecretKey === '') {
    throw new WorkBuddyAtRestError('the WorkBuddy at-rest accessor returned no usable secret')
  }
  return deriveProtectorKey(candidate.atRestSecretKey)
}

/**
 * A document-level unlocker: sealed auth document in, plaintext document out.
 *
 * Throws {@link WorkBuddyAtRestError} with a human reason when the unlock is
 * unavailable, so the caller can report *why* the stored sign-in is unusable
 * instead of pretending nobody is signed in.
 */
export type WorkBuddyAuthUnlocker = (text: string) => Promise<string>

/** The default unlocker: derive the key from the app binary and open the fields. */
export function createAtRestUnlocker(options: { binary?: string } = {}): WorkBuddyAuthUnlocker {
  return async (text: string): Promise<string> => {
    const document: unknown = JSON.parse(text)
    const key = await resolveProtectorKey(options.binary)
    const opened = openSealedFields(document, key)
    return JSON.stringify(opened)
  }
}
