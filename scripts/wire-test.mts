/**
 * Full-stack wire test: boots the real keep.exe, then drives the client's
 * actual KeepConnection class (the same code the Electron renderer runs)
 * through discovery → handshake → world → gateway → messaging → admin rename.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KeepConnection, type KeepMessage } from '../src/renderer/src/net/keep'
import { forgeIdentity } from '../src/renderer/src/lib/identity'

const PORT = 7799
const HOST = '127.0.0.1'

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) {
    failures++
    console.error(`FAIL ${label}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

async function until(label: string, fn: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for: ${label}`)
}

// ── boot the keep ───────────────────────────────────────────────────
const exeName = process.env.KEEP_EXE ?? 'keep.exe'
const dataDir = mkdtempSync(join(tmpdir(), 'keep-wire-'))
const keep = spawn(
  join(import.meta.dirname, '..', 'keep', exeName),
  ['-addr', `:${PORT}`, '-data', join(dataDir, 'keep.db'), '-name', 'Wire Test Keep'],
  // run the server in-process (not the self-supervisor) so we can manage it
  { env: { ...process.env, KEEP_SUPERVISED: '1' } }
)
let keepLog = ''
keep.stderr.on('data', (d: Buffer) => (keepLog += d.toString()))
keep.stdout.on('data', (d: Buffer) => (keepLog += d.toString()))

try {
  // wait for it to answer discovery
  const probe = new KeepConnection({ host: HOST, port: PORT })
  let disc: Awaited<ReturnType<typeof probe.discover>> | null = null
  for (let i = 0; i < 30 && !disc; i++) {
    disc = await probe.discover().catch(() => null)
    if (!disc) await new Promise((r) => setTimeout(r, 200))
  }
  if (!disc) throw new Error(`keep never came up. log:\n${keepLog}`)
  check('discovery', disc.name === 'Wire Test Keep' && disc.protocol === 'relic.v1')

  // ── two local identities, exactly as the client forges them ──────
  const aria = await forgeIdentity('Aria', '#3ddcc4', 'password-aria')
  const kade = await forgeIdentity('Kade', '#8b7cf6', 'password-kade')

  const ariaMsgs: KeepMessage[] = []
  const kadeMsgs: KeepMessage[] = []
  const connA = new KeepConnection({ host: HOST, port: PORT }, { onMessage: (m) => ariaMsgs.push(m) })
  const connB = new KeepConnection({ host: HOST, port: PORT }, { onMessage: (m) => kadeMsgs.push(m) })

  // owner claims the keep
  await connA.discover()
  const userA = await connA.handshake(
    { pub: aria.identity.pub, name: 'Aria', accent: '#3ddcc4' },
    aria.privKey
  )
  check('first identity claims the keep', userA.role === 'owner')
  check('keep generated a profile from the handshake', userA.fingerprint === aria.identity.fingerprint)

  const worldA = await connA.fetchWorld()
  check('world has seeded channels', worldA.channels.length === 3)
  connA.openGateway()

  // second identity needs an invite
  await connB.discover()
  let rejected = false
  await connB
    .handshake({ pub: kade.identity.pub, name: 'Kade', accent: '#8b7cf6' }, kade.privKey)
    .catch(() => (rejected = true))
  check('uninvited identity rejected', rejected)

  const invite = await connA.createInvite(3600, 1)
  await connB.handshake(
    { pub: kade.identity.pub, name: 'Kade', accent: '#8b7cf6' },
    kade.privKey,
    { invite: invite.token }
  )
  await connB.fetchWorld()
  connB.openGateway()

  // presence: B's world should show Aria online once gateways settle
  await until('presence sync', () => {
    const m = connB.world?.members.find((x) => x.fingerprint === aria.identity.fingerprint)
    return m?.online === true
  })
  check('presence visible across clients', true)

  // chosen status states (idle/dnd/invisible) sync to other members
  const ariaSeenByB = (): { online: boolean; state?: string } | undefined =>
    connB.world?.members.find((x) => x.fingerprint === aria.identity.fingerprint)
  connA.setPresence('idle')
  await until('idle syncs', () => ariaSeenByB()?.state === 'idle')
  check('idle status visible to other members', true)

  connA.setPresence('invisible')
  await until('invisible hides', () => {
    const m = ariaSeenByB()
    return m?.online === false && m?.state === 'offline'
  })
  check('invisible appears offline to others', true)

  connA.setPresence('online')
  await until('back online', () => ariaSeenByB()?.state === 'online')
  check('status restores to online', true)

  // ── messaging across the wire ─────────────────────────────────────
  const tavern = worldA.channels.find((c) => c.kind === 'text')!
  await connA.sendMessage(tavern.id, 'the wire sings ⚡')
  await until('message reaches both gateways', () =>
    ariaMsgs.some((m) => m.content === 'the wire sings ⚡') &&
    kadeMsgs.some((m) => m.content === 'the wire sings ⚡')
  )
  const received = kadeMsgs.find((m) => m.content === 'the wire sings ⚡')!
  check('broadcast carries the author profile', received.author.username === 'Aria')

  const history = await connB.loadMessages(tavern.id)
  check('history fetch returns the message', history.some((m) => m.content === 'the wire sings ⚡'))

  // ── profile + media: avatar GIF uploaded by A, seen by B ──────────
  const gifBytes = 'GIF89a\x01\x00\x01\x00\x00\xff\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x00;'
  const raw = Uint8Array.from(gifBytes, (c) => c.charCodeAt(0))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
  const avatarHash = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
  let bin = ''
  for (const b of raw) bin += String.fromCharCode(b)
  const avatarRef = { hash: avatarHash, type: 'image/gif', dataUrl: `data:image/gif;base64,${btoa(bin)}` }

  const profile = { about: 'spreading managed democracy', status: 'in a dive', avatar: avatarRef }
  await connA.ensureMedia(profile)
  check('client uploads avatar bytes the keep was missing', await connA.mediaExists(avatarHash))
  await connA.patchProfile({
    username: 'Aria', accent: '#3ddcc4', about: profile.about, status: profile.status,
    avatar: avatarHash, background: '', name_font: 'orbitron', name_effect: 'neon', name_color: '#ff6b81'
  })

  await until('profile patch reaches other members', () => {
    const m = connB.world?.members.find((x) => x.fingerprint === aria.identity.fingerprint)
    return m?.about === 'spreading managed democracy' && m?.avatar === avatarHash
  })
  check('avatar + about + status sync across clients', true)
  const ariaB = connB.world?.members.find((x) => x.fingerprint === aria.identity.fingerprint)
  check('name font + effect + color sync across clients',
    ariaB?.name_font === 'orbitron' && ariaB?.name_effect === 'neon' && ariaB?.name_color === '#ff6b81')

  // ── admin lock: owner locks name styling, other client sees the flag ──
  await connA.setNameLock(true)
  await until('lock flag propagates', () => connB.world?.lock_name_style === true)
  check('owner locks username styling, ripples to clients', true)
  await connA.setNameLock(false)
  await until('unlock propagates', () => connB.world?.lock_name_style === false)
  check('owner unlocks username styling', true)

  // ── events: owner creates one, member sees it sync via gateway ──────
  const voice = (connA.world?.channels ?? []).find((c) => c.kind === 'voice')
  if (!voice) throw new Error('no seeded voice channel')
  const evStart = Date.now() + 3600_000
  const created = await connA.createEvent({
    title: 'Raid Night', description: 'bring stims', location_kind: 'voice',
    channel_id: voice.id, location_text: '', cover: '',
    starts_at: evStart, ends_at: evStart + 3600_000, frequency: 'weekly'
  })
  check('owner creates an event with start + end', created.title === 'Raid Night' && created.ends_at === evStart + 3600_000)
  await until('event syncs to other client', () =>
    (connB.world?.events ?? []).some((e) => e.id === created.id && e.title === 'Raid Night')
  )
  check('event syncs across clients via gateway', true)
  await connA.deleteEvent(created.id)
  await until('event delete syncs', () =>
    !(connB.world?.events ?? []).some((e) => e.id === created.id)
  )
  check('event deletion syncs across clients', true)
  check('mediaUrl points at the keep', connB.mediaUrl(avatarHash).endsWith(`/v1/media/${avatarHash}`))

  // ── client-side management (the in-app Server Settings panel) ─────
  await connA.setName('Renamed From Client')
  await until('client rename ripples', () => connB.world?.name === 'Renamed From Client')
  check('owner renames the keep from the client', true)

  const newCh = await connA.createChannel('Raid Plans', 'text')
  check('owner creates a channel from the client', newCh.name === 'raid-plans')
  await until('channel ripples to other client', () =>
    (connB.world?.channels ?? []).some((c) => c.name === 'raid-plans')
  )
  await connA.renameChannel(newCh.id, 'war-plans')
  await connA.deleteChannel(newCh.id)
  const invites = await connA.listInvites()
  check('owner lists invites from the client', invites.length >= 1)
  await connA.revokeInvite(invites[0].token)

  // member (kade) must NOT be able to manage
  let denied = false
  await connB.setName('Kade Was Here').catch(() => (denied = true))
  check('member cannot manage the keep', denied)

  // ── host console: keep password gate ──────────────────────────────
  const keyMatch = keepLog.match(/admin key:\s+([0-9a-f]+)/)
  if (!keyMatch) throw new Error(`no admin key in keep log:\n${keepLog}`)
  const hostKey = keyMatch[1]

  // host endpoints reject even the owner's bearer token
  const hostWithBearer = await fetch(`http://${HOST}:${PORT}/v1/host/state`, {
    headers: { Authorization: `Bearer ${connA.token}` }
  })
  check('host console rejects client tokens', hostWithBearer.status === 403)

  const pwRes = await fetch(`http://${HOST}:${PORT}/v1/host/keep-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': hostKey },
    body: JSON.stringify({ password: 'sanctum' })
  })
  check('host sets keep password', pwRes.ok)

  const mira = await forgeIdentity('Mira', '#ff6b81', 'password-mira')
  const connC = new KeepConnection({ host: HOST, port: PORT })
  await connC.discover()
  const rescue = await (
    await fetch(`http://${HOST}:${PORT}/v1/host/rescue-invite`, {
      method: 'POST',
      headers: { 'X-Admin-Key': hostKey }
    })
  ).json()
  let gateCode = ''
  await connC
    .handshake({ pub: mira.identity.pub, name: 'Mira', accent: '#ff6b81' }, mira.privKey, {
      invite: rescue.token
    })
    .catch((e) => (gateCode = e.code))
  check('keep password gate blocks even invited joiners', gateCode === 'keep_password_required')
  await connC.handshake({ pub: mira.identity.pub, name: 'Mira', accent: '#ff6b81' }, mira.privKey, {
    invite: rescue.token,
    keepPassword: 'sanctum'
  })
  check('correct keep password admits the joiner', connC.self?.username === 'Mira')

  connA.close()
  connB.close()
  connC.close()
} finally {
  keep.kill()
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall wire tests passed — the client and the keep speak fluently')
