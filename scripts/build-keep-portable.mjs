// Build the portable Keep package: a static keep.exe + launcher + readme, zipped.
// Output: dist/Keep-Portable-Windows.zip  (uploaded to the release by ensure-release.mjs)
//
// Needs Go on PATH. CGO is off (modernc.org/sqlite is pure Go), so the binary is
// fully self-contained — no install, no dependencies on the target machine.

import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const stage = join(dist, 'keep-portable')
const zipPath = join(dist, 'Keep-Portable-Windows.zip')
const manifestPath = join(dist, 'keep-latest.json')

// Stamp the binary with the release version so it can compare itself against the
// GitHub release manifest and self-update (see keep/internal/update).
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

rmSync(dist, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

console.log(`building static keep.exe v${version} (windows/amd64, CGO off)…`)
const ldflags = `-s -w -X reliquary.gg/keep/internal/api.ServerVersion=${version}`
execSync(`go build -trimpath -ldflags "${ldflags}" -o "${join(stage, 'keep.exe')}" ./cmd/keep`, {
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

// Self-update manifest: a running Keep fetches this from the latest release,
// compares versions, and verifies the downloaded zip against this SHA-256.
const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
const manifest = { version, sha256, asset: 'Keep-Portable-Windows.zip' }
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

console.log('built', zipPath)
console.log('manifest', manifest)
