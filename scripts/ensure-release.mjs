// Idempotently create the GitHub release for the current package.json version
// BEFORE electron-builder publishes, and attach the web installer to it.
//
// Two jobs:
//  1. Pre-create the release. electron-builder uploads its artifacts concurrently
//     and they race to create the release — one wins, the other 422s and drops its
//     files. Pre-creating means electron-builder always just *finds and uploads*.
//  2. Upload installation_File/ReliquarySetup.exe (the version-agnostic web
//     installer / bootstrapper) as a release asset, so the stable link
//     https://github.com/HPelto/Reliquary/releases/latest/download/ReliquarySetup.exe
//     always serves the current installer. Skipped if the file isn't present.
//
// Needs GH_TOKEN in the environment (same as `electron-builder --publish`).

import { readFileSync, existsSync } from 'node:fs'

const REPO = 'HPelto/Reliquary'
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
const tag = `v${version}`

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token) {
  console.error('ensure-release: GH_TOKEN not set')
  process.exit(1)
}
const headers = {
  Authorization: `token ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'reliquary-release'
}

const getRelease = async () => {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers })
  return r.ok ? r.json() : null
}

let release = await getRelease()
if (release) {
  console.log(`ensure-release: ${tag} already exists`)
} else {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: version, draft: false, prerelease: false })
  })
  if (res.ok) {
    release = await res.json()
    console.log(`ensure-release: created ${tag}`)
  } else if (res.status === 422) {
    // already_exists = someone created it in parallel; fetch it back
    release = await getRelease()
    console.log(`ensure-release: ${tag} already exists (422)`)
  } else {
    const body = await res.json().catch(() => ({}))
    console.error(`ensure-release: failed (${res.status})`, body.message ?? '')
    process.exit(1)
  }
}

// Attach the web installer so the "latest download" link always works.
const exe = new URL('../installation_File/ReliquarySetup.exe', import.meta.url)
const ASSET = 'ReliquarySetup.exe'
if (release && existsSync(exe)) {
  // Replace any existing same-named asset (so re-runs / new builds overwrite).
  const prior = (release.assets ?? []).find((a) => a.name === ASSET)
  if (prior) {
    await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${prior.id}`, {
      method: 'DELETE',
      headers
    })
  }
  const bytes = readFileSync(exe)
  const uploadBase = release.upload_url.replace(/\{.*\}$/, '')
  const up = await fetch(`${uploadBase}?name=${ASSET}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
    body: bytes
  })
  if (up.ok) {
    console.log(`ensure-release: uploaded ${ASSET} (${(bytes.length / 1e6).toFixed(1)} MB)`)
  } else {
    const body = await up.json().catch(() => ({}))
    console.error(`ensure-release: installer upload failed (${up.status})`, body.message ?? '')
    // Non-fatal: the client release still publishes; the installer link just won't refresh.
  }
} else if (release) {
  console.log(`ensure-release: ${ASSET} not found locally — skipping installer asset upload`)
}
