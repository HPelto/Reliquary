// One-off: set release notes on every existing GitHub release from its commit
// subjects (the range since the previous tag). Future releases get notes
// automatically via ensure-release.mjs; this backfills the ones already out.
//
//   GH_TOKEN=... node scripts/backfill-release-notes.mjs

import { execSync } from 'node:child_process'

const REPO = 'HPelto/Reliquary'
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token) {
  console.error('backfill: GH_TOKEN not set')
  process.exit(1)
}
const headers = {
  Authorization: `token ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'reliquary-release',
  'Content-Type': 'application/json'
}
const git = (cmd) => {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

git('git fetch --tags --quiet')

function bodyFor(tag, version) {
  const prev = git(`git describe --tags --abbrev=0 ${tag}^`)
  const range = prev ? `${prev}..${tag}` : `${tag} -n 25`
  const subjects = git(`git log ${range} --no-merges --pretty=format:%s`)
    .split('\n')
    .map((s) => s.trim())
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
    '- **Host your own server:** download `Keep-Portable-Windows.zip` below (where present), unzip, run `start-keep.cmd`.',
    '',
    '_Client updates apply automatically. Server changes reach a running Keep via the Host Console → Update & Restart._'
  ].join('\n')
}

const releases = await (
  await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers })
).json()

for (const r of releases) {
  const version = r.tag_name.replace(/^v/, '')
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/${r.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ name: version, body: bodyFor(r.tag_name, version) })
  })
  console.log(res.ok ? `ok    ${r.tag_name}` : `FAIL  ${r.tag_name} (${res.status})`)
}
