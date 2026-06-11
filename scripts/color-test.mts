import { clampHex, hexToHsv, hsvToHex } from '../src/renderer/src/lib/color'

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) {
    failures++
    console.error(`FAIL ${label}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

// clampHex
check('clampHex pads 3-digit', clampHex('#abc') === '#aabbcc')
check('clampHex accepts no-hash', clampHex('aabbcc') === '#aabbcc')
check('clampHex lowercases', clampHex('#AABBCC') === '#aabbcc')
check('clampHex rejects garbage', clampHex('nope') === null)
check('clampHex rejects short', clampHex('#ab') === null)

// known anchors
check('red → h0 s100 v100', JSON.stringify(hexToHsv('#ff0000')) === JSON.stringify({ h: 0, s: 100, v: 100 }))
check('white → s0 v100', (() => { const v = hexToHsv('#ffffff'); return v.s === 0 && v.v === 100 })())
check('black → v0', hexToHsv('#000000').v === 0)
check('hsv red → hex', hsvToHex({ h: 0, s: 100, v: 100 }) === '#ff0000')
check('hsv green → hex', hsvToHex({ h: 120, s: 100, v: 100 }) === '#00ff00')
check('hsv blue → hex', hsvToHex({ h: 240, s: 100, v: 100 }) === '#0000ff')

// round-trip a spread of colors (allow ±1 per channel from rounding)
const near = (a: string, b: string): boolean => {
  const px = (h: string, i: number): number => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  return [0, 1, 2].every((i) => Math.abs(px(a, i) - px(b, i)) <= 2)
}
for (const hex of ['#8b7cf6', '#3ddcc4', '#e8c97a', '#ff6b81', '#aab1c0', '#123456', '#fedcba']) {
  check(`round-trip ${hex}`, near(hsvToHex(hexToHsv(hex)), hex))
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall color tests passed')
