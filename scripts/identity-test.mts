import {
  forgeIdentity,
  restoreIdentity,
  unlockWithPassword,
  unlockWithRecoveryKey,
  setNewPassword,
  normalizeRecoveryKey,
  validateRecoveryKey,
  signNonce
} from '../src/renderer/src/lib/identity'

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) {
    failures++
    console.error(`FAIL ${label}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

const { identity, recoveryKey, privKey } = await forgeIdentity('Voidwalker', '#8b7cf6', 'hunter22hunter')

check('identity has no plaintext seed', !JSON.stringify(identity).includes(privKey))
check('recovery key format (8 data groups + checksum)', /^([0-9A-Z]{4}-){8}[0-9A-Z]{4}$/.test(recoveryKey))
check('fingerprint format', /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(identity.fingerprint))
check('checksum validates', await validateRecoveryKey(recoveryKey))
const typo = recoveryKey.slice(0, -1) + (recoveryKey.endsWith('A') ? 'B' : 'A')
check('typo fails checksum', !(await validateRecoveryKey(typo)))

// password unlock
check('correct password unlocks', (await unlockWithPassword(identity, 'hunter22hunter')) === privKey)
check('wrong password fails', (await unlockWithPassword(identity, 'wrong-password')) === null)

// recovery unlock, including messy human input
check('recovery key unlocks', (await unlockWithRecoveryKey(identity, recoveryKey)) === privKey)
const messy = ' ' + recoveryKey.toLowerCase().replace(/-/g, ' ') + ' '
check('messy-formatted recovery key unlocks', (await unlockWithRecoveryKey(identity, messy)) === privKey)
check('lookalike normalization', normalizeRecoveryKey('o1l-i0') === '01110')

// ── THE disaster scenario: total data loss, only the recovery key survives ──
const reborn = await restoreIdentity(recoveryKey, 'Voidwalker', '#8b7cf6', 'completely-new-password')
check('restore rebuilds the SAME public key', reborn.identity.pub === identity.pub)
check('restore rebuilds the SAME fingerprint', reborn.identity.fingerprint === identity.fingerprint)
check('restore rebuilds the SAME seed', reborn.privKey === privKey)
check('restored identity unlocks with its new password',
  (await unlockWithPassword(reborn.identity, 'completely-new-password')) === privKey)

// a typo'd key must throw, never silently derive a different identity
let threw = false
await restoreIdentity(typo, 'Voidwalker', '#8b7cf6', 'whatever-password').catch(() => (threw = true))
check('restore with typo throws instead of forking identity', threw)

// password reset: old dies, new works, recovery key untouched
const updated = await setNewPassword(identity, privKey, 'brand-new-password')
check('new password unlocks after reset', (await unlockWithPassword(updated, 'brand-new-password')) === privKey)
check('old password fails after reset', (await unlockWithPassword(updated, 'hunter22hunter')) === null)
check('recovery key still unlocks after reset', (await unlockWithRecoveryKey(updated, recoveryKey)) === privKey)

// wrong recovery key for this identity → null (pubkey mismatch)
const other = await forgeIdentity('Other', '#3ddcc4', 'hunter22hunter')
check('another identity’s key is rejected', (await unlockWithRecoveryKey(identity, other.recoveryKey)) === null)

// the seed actually signs — verify against the public key via WebCrypto
const nonce = 'test-nonce-from-a-keep'
const sigB64 = await signNonce(privKey, nonce)
const pubRaw = Uint8Array.from(atob(identity.pub), (c) => c.charCodeAt(0))
const pub = await crypto.subtle.importKey('raw', pubRaw, 'Ed25519', false, ['verify'])
const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0))
check('signature verifies against public key',
  await crypto.subtle.verify('Ed25519', pub, sig, new TextEncoder().encode(nonce)))
check('signature bound to the nonce',
  !(await crypto.subtle.verify('Ed25519', pub, sig, new TextEncoder().encode('other'))))

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall identity tests passed — the recovery key alone rebuilds the account')
