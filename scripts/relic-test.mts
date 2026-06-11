import {
  encodeRelicCode,
  decodeRelicCode,
  parseAddress,
  parseHostPort,
  joinLink,
  toUri
} from '../src/renderer/src/lib/relic'

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) {
    failures++
    console.error(`FAIL ${label}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

// round-trips through the encrypted codec
const cases = [
  { host: '203.0.113.7', port: 7777, name: 'Murkwater Keep', token: 'x7Kp2' },
  { host: 'vault.aria-clan.gg', port: 443 },
  { host: '10.0.0.42', port: 65535, name: 'Léon’s Käller ⚔️', fingerprint: 'a1b2c3d4e5f6' },
  { host: '192.168.1.1', port: 1 }
]
for (const c of cases) {
  const code = await encodeRelicCode(c)
  const back = await decodeRelicCode(code)
  check(
    `roundtrip ${c.host}:${c.port}`,
    !!back &&
      back.host === c.host &&
      back.port === c.port &&
      back.name === c.name &&
      back.token === c.token &&
      back.fingerprint === c.fingerprint
  )
  check(`parseAddress accepts code for ${c.host}`, (await parseAddress(code))?.host === c.host)
  check(
    `code is uppercase-safe ${c.host}`,
    (await decodeRelicCode(code.toLowerCase()))?.host === c.host
  )
  check(
    `join link unpacks for ${c.host}`,
    (await parseAddress(joinLink(code)))?.host === c.host
  )
}

// the whole point: the IP must not be recoverable from the string itself
const codeA = await encodeRelicCode({ host: '203.0.113.7', port: 7777, token: 'x7Kp2' })
const codeB = await encodeRelicCode({ host: '203.0.113.7', port: 7777, token: 'x7Kp2' })
check('no plaintext host in code', !codeA.includes('203') || !codeA.includes('113'))
check('codes are non-deterministic (fresh key)', codeA !== codeB)
const truncated = codeA.slice(0, Math.floor(codeA.length * 0.8))
check('truncated code rejected (GCM auth)', (await decodeRelicCode(truncated)) === null)
const tampered = codeA.slice(0, -2) + (codeA.endsWith('A') ? 'B' : 'A') + codeA.slice(-1)
check('tampered code rejected (GCM auth)', (await decodeRelicCode(tampered)) === null)
check('old REL2 prefix rejected', (await decodeRelicCode('REL2-ABCDE-12345')) === null)

// size: the complaint that prompted this — an IP invite should be compact
const ipCodeLen = codeA.replace(/-/g, '').length
console.log(`     IP invite code length: ${ipCodeLen} chars (raw), join link: ${joinLink(codeA).length}`)
check('IP invite code under 70 chars', ipCodeLen < 70)

// parser forms
check('bare ip', (await parseAddress('203.0.113.7'))?.port === 7777)
check('ip:port', (await parseAddress('203.0.113.7:9000'))?.port === 9000)
check('domain', (await parseAddress('keep.murkwater.io'))?.host === 'keep.murkwater.io')
check('domain:port', (await parseAddress('Keep.Murkwater.IO:8443'))?.port === 8443)
const uri = await parseAddress('relic://vault.aria-clan.gg/x7Kp2')
check('relic uri host', uri?.host === 'vault.aria-clan.gg')
check('relic uri token', uri?.token === 'x7Kp2')
check('relic uri ip', (await parseAddress('relic://203.0.113.7:7777/abc'))?.source === 'ip')
check('garbage rejected', (await parseAddress('not an address!!')) === null)
check('empty rejected', (await parseAddress('   ')) === null)
check('bad port rejected', (await parseAddress('1.2.3.4:99999')) === null)
check('parseHostPort rejects codes', parseHostPort(codeA) === null)
check('toUri default port', toUri({ host: 'a.gg', port: 7777, source: 'domain' }) === 'relic://a.gg')
check(
  'toUri custom port+token',
  toUri({ host: '1.2.3.4', port: 9000, token: 'q', source: 'ip' }) === 'relic://1.2.3.4:9000/q'
)

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall relic codec tests passed')
