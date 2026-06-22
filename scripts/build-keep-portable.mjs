// Build the portable Keep package: a static keep.exe + launcher + readme, zipped.
// Output: dist/Keep-Portable-Windows.zip  (uploaded to the release by ensure-release.mjs)
//
// Needs Go on PATH. CGO is off (modernc.org/sqlite is pure Go), so the binary is
// fully self-contained — no install, no dependencies on the target machine.

import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const stage = join(dist, 'keep-portable')
const zipPath = join(dist, 'Keep-Portable-Windows.zip')

rmSync(dist, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

console.log('building static keep.exe (windows/amd64, CGO off)…')
execSync(`go build -trimpath -ldflags "-s -w" -o "${join(stage, 'keep.exe')}" ./cmd/keep`, {
  cwd: join(root, 'keep'),
  stdio: 'inherit',
  env: { ...process.env, CGO_ENABLED: '0', GOOS: 'windows', GOARCH: 'amd64' }
})

copyFileSync(join(root, 'keep', 'portable', 'start-keep.cmd'), join(stage, 'start-keep.cmd'))
copyFileSync(join(root, 'keep', 'portable', 'README.txt'), join(stage, 'README.txt'))

console.log('zipping…')
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force"`,
  { stdio: 'inherit' }
)
console.log('built', zipPath)
