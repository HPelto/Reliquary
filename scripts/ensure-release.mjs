// Idempotently create the GitHub release for the current package.json version
// BEFORE electron-builder publishes. electron-builder uploads its artifacts
// concurrently, and they race to create the release — one wins, the other 422s
// and drops its files. Pre-creating the release means electron-builder always
// just *finds and uploads*, never creates, so the race can't happen.
//
// Needs GH_TOKEN in the environment (same as `electron-builder --publish`).

import { readFileSync } from 'node:fs'

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
  'User-Agent': 'reliquary-release',
  'Content-Type': 'application/json'
}

const existing = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers })
if (existing.ok) {
  console.log(`ensure-release: ${tag} already exists — nothing to do`)
  process.exit(0)
}

const res = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ tag_name: tag, name: version, draft: false, prerelease: false })
})
if (res.ok) {
  console.log(`ensure-release: created ${tag}`)
  process.exit(0)
}
// 422 already_exists = someone created it in parallel; that's fine
if (res.status === 422) {
  console.log(`ensure-release: ${tag} already exists (422)`)
  process.exit(0)
}
const body = await res.json().catch(() => ({}))
console.error(`ensure-release: failed (${res.status})`, body.message ?? '')
process.exit(1)
