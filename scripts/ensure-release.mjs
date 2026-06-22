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
import { execSync } from 'node:child_process'

const REPO = 'HPelto/Reliquary'
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
const tag = `v${version}`

// Release notes from the commit subjects since the previous release tag.
function buildBody() {
  const git = (cmd) => {
    try {
      return execSync(cmd, { encoding: 'utf8' }).trim()
    } catch {
      return ''
    }
  }
  const prev = git(`git describe --tags --abbrev=0 ${tag}^`)
  const range = prev ? `${prev}..${tag}` : `${tag} -n 25`
  const subjects = git(`git log ${range} --no-merges --pretty=format:%s`)
    .split('\n')
    .map((s) => s.trim())
    // drop the version-bump commit (just the bare version number)
    .filter((s) => s && !/^v?\d+\.\d+\.\d+$/.test(s))
  const bullets = subjects.length ? subjects.map((s) => `- ${s}`).join('\n') : '- Maintenance and fixes'
  return [
    `## What's new in ${version}`,
    '',
    bullets,
    '',
    '---',
    '',
    '**Get Reliquary**',
    '- **Client (Windows):** the installer below, or https://hpelto.github.io/Reliquary/',
    '- **Host your own server:** download `Keep-Portable-Windows.zip` below, unzip, and run `start-keep.cmd` — no install needed.',
    '',
    '_Client updates apply automatically. Server changes reach a running Keep via the Host Console → Update & Restart._'
  ].join('\n')
}
const body = buildBody()

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
  // keep the notes current (handy on re-runs / backfills)
  await fetch(`https://api.github.com/repos/${REPO}/releases/${release.id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: version, body })
  })
  console.log(`ensure-release: ${tag} already exists — refreshed notes`)
} else {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: version, body, draft: false, prerelease: false })
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

// Attach extra assets so their "latest download" links always work. Non-fatal:
// a failed upload doesn't block the client release.
async function uploadAsset(fileUrl, assetName) {
  if (!release || !existsSync(fileUrl)) {
    console.log(`ensure-release: ${assetName} not found locally — skipping`)
    return
  }
  const prior = (release.assets ?? []).find((a) => a.name === assetName)
  if (prior) {
    await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${prior.id}`, {
      method: 'DELETE',
      headers
    })
  }
  const bytes = readFileSync(fileUrl)
  const uploadBase = release.upload_url.replace(/\{.*\}$/, '')
  const up = await fetch(`${uploadBase}?name=${assetName}`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length)
    },
    body: bytes
  })
  if (up.ok) {
    console.log(`ensure-release: uploaded ${assetName} (${(bytes.length / 1e6).toFixed(1)} MB)`)
  } else {
    const body = await up.json().catch(() => ({}))
    console.error(`ensure-release: ${assetName} upload failed (${up.status})`, body.message ?? '')
  }
}

// the version-agnostic web installer (stable /releases/latest/download link)
await uploadAsset(new URL('../installation_File/ReliquarySetup.exe', import.meta.url), 'ReliquarySetup.exe')
// the portable Keep server package
await uploadAsset(new URL('../dist/Keep-Portable-Windows.zip', import.meta.url), 'Keep-Portable-Windows.zip')
