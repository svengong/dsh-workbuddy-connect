import { createCipheriv, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAtRestUnlocker,
  defaultAppBinaryCandidates,
  deriveKeyId,
  deriveProtectorKey,
  envelopeAad,
  isSealedField,
  openSealedFields,
  protectorKeyFromProbe,
  resetProtectorKeyCache,
  WORKBUDDY_APP_BINARY_ENV,
  WorkBuddyAtRestError,
} from '../src/at-rest.ts'

afterEach(() => {
  resetProtectorKeyCache()
  delete process.env[WORKBUDDY_APP_BINARY_ENV]
})

/** A sealed field node, produced with the same framing the app uses. */
function seal(plaintext: string, secret: string, framing: 'field' | 'file' = 'field'): unknown {
  const key = deriveProtectorKey(secret)
  const keyId = deriveKeyId(key)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(envelopeAad(keyId, framing, 1))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const envelope = Buffer.from(JSON.stringify({
    suite: 1,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }), 'utf8').toString('base64')
  return { $wbEncrypted: 1, envelope }
}

describe('at-rest sealed fields', () => {
  it('recognizes the sealed wrapper and nothing else', () => {
    expect(isSealedField({ $wbEncrypted: 1, envelope: 'x' })).toBe(true)
    expect(isSealedField({ $wbEncrypted: 1 })).toBe(false)
    expect(isSealedField({ envelope: 'x' })).toBe(false)
    expect(isSealedField('x')).toBe(false)
    expect(isSealedField(null)).toBe(false)
    expect(isSealedField([{ $wbEncrypted: 1, envelope: 'x' }])).toBe(false)
  })

  it('derives a 16-hex-digit key id', () => {
    expect(deriveKeyId(deriveProtectorKey('secret'))).toMatch(/^[0-9a-f]{16}$/u)
    // The derivation hashes the base64 *text*, so a different text means a
    // different key — this is what makes the app's key ids reproducible.
    expect(deriveKeyId(deriveProtectorKey('secret'))).not.toBe(deriveKeyId(deriveProtectorKey('secret ')))
  })

  it('opens sealed fields anywhere in a nested document', () => {
    const key = deriveProtectorKey('secret')
    const document = {
      auth: { accessToken: seal('at-token', 'secret'), expiresAt: 1_792_000_000_000, tokenType: 'Bearer' },
      account: { uid: 'uid-1', tags: ['a', seal('nested', 'secret')] },
    }
    expect(openSealedFields(document, key)).toEqual({
      auth: { accessToken: 'at-token', expiresAt: 1_792_000_000_000, tokenType: 'Bearer' },
      account: { uid: 'uid-1', tags: ['a', 'nested'] },
    })
  })

  it('refuses a field sealed under a different key', () => {
    const document = { auth: { accessToken: seal('at-token', 'other-secret') } }
    expect(() => openSealedFields(document, deriveProtectorKey('secret')))
      .toThrow(/different key/u)
  })

  it('refuses a tampered envelope', () => {
    const sealed = seal('at-token', 'secret') as { $wbEncrypted: 1, envelope: string }
    const envelope = JSON.parse(Buffer.from(sealed.envelope, 'base64').toString('utf8')) as Record<string, string>
    const ciphertext = Buffer.from(envelope['ciphertext'] as string, 'base64')
    ciphertext[0] = (ciphertext[0] as number) ^ 0xff
    envelope['ciphertext'] = ciphertext.toString('base64')
    const tampered = {
      $wbEncrypted: 1 as const,
      envelope: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64'),
    }
    expect(() => openSealedFields({ auth: { accessToken: tampered } }, deriveProtectorKey('secret')))
      .toThrow(WorkBuddyAtRestError)
  })

  it('rejects an unsupported envelope suite', () => {
    const sealed = seal('at-token', 'secret') as { $wbEncrypted: 1, envelope: string }
    const envelope = JSON.parse(Buffer.from(sealed.envelope, 'base64').toString('utf8')) as Record<string, unknown>
    envelope['suite'] = 2
    const other = {
      $wbEncrypted: 1 as const,
      envelope: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64'),
    }
    expect(() => openSealedFields({ auth: { accessToken: other } }, deriveProtectorKey('secret')))
      .toThrow(/unsupported at-rest envelope suite/u)
  })

  it('uses the field framing for document fields', () => {
    // A field sealed with the file framing must not open as a document field:
    // the AAD separates the two framings.
    const document = { auth: { accessToken: seal('at-token', 'secret', 'file') } }
    expect(() => openSealedFields(document, deriveProtectorKey('secret'))).toThrow(WorkBuddyAtRestError)
  })
})

describe('at-rest accessor payload', () => {
  it('derives the key from a well-formed payload', () => {
    const payload = JSON.stringify({ version: 1, atRestSecretKey: 'c2VjcmV0', atRestDeveloperPublicKey: {} })
    expect(deriveKeyId(protectorKeyFromProbe(payload))).toBe(deriveKeyId(deriveProtectorKey('c2VjcmV0')))
  })

  it('rejects a payload that is not usable', () => {
    expect(() => protectorKeyFromProbe('not json')).toThrow(/did not return JSON/u)
    expect(() => protectorKeyFromProbe('null')).toThrow(/unexpected payload/u)
    expect(() => protectorKeyFromProbe(JSON.stringify({ version: 2, atRestSecretKey: 'x' }))).toThrow(/no usable secret/u)
    expect(() => protectorKeyFromProbe(JSON.stringify({ version: 1 }))).toThrow(/no usable secret/u)
  })

  it('lists no binary on a platform without one', () => {
    // The candidate list is platform-driven; only darwin has a wired path.
    if (process.platform !== 'darwin') expect(defaultAppBinaryCandidates()).toEqual([])
    else expect(defaultAppBinaryCandidates().every(path => path.endsWith('Electron'))).toBe(true)
  })

  it('honours the binary override', () => {
    process.env[WORKBUDDY_APP_BINARY_ENV] = '/tmp/fake-workbuddy-electron'
    expect(defaultAppBinaryCandidates()).toEqual(['/tmp/fake-workbuddy-electron'])
  })

  it('surfaces the unlocker failure instead of a credential', async () => {
    const unlock = createAtRestUnlocker({ binary: '/nonexistent/workbuddy-electron' })
    await expect(unlock(JSON.stringify({ auth: { accessToken: seal('at-token', 'secret') } })))
      .rejects.toThrow(WorkBuddyAtRestError)
  })
})
