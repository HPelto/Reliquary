# Security

Reliquary is self-hosted, identity-first chat. This document explains the
security model honestly — what protects you, and just as importantly, what does
**not** — so you can decide what to trust it with.

If you find a vulnerability, see [Reporting](#reporting-a-vulnerability) below.

## TL;DR

- Your **account is a keypair you alone hold** — no email, no password reset, no
  central account server. A recovery key is the only way back in.
- **Transport is encrypted** (HTTPS/WSS if the owner enables TLS; the peer-to-peer
  transport is always DTLS-encrypted and bound to the Keep's identity key).
- **The Keep's owner can read everything sent to their Keep.** Messages are
  **not** end-to-end encrypted. This is by design — a Keep is a community server
  you choose to trust, like any self-hosted service. The join screen says so.
- Encryption **at rest** (on the owner's disk) is planned and opt-in, not yet
  shipped.

## Identity & accounts

- Each identity is an **Ed25519 keypair generated locally** in the client. There
  is no account server and no password reset.
- The **recovery key** (a 160-bit secret shown as word-like groups) *is* the
  master seed; the keypair is derived from it. It rebuilds the identical account
  on any machine. **Lose it with your password and the account is gone** — there
  is no backdoor. Keep it somewhere safe and offline.
- At rest on your device, the seed is wrapped with **AES-256-GCM** under a key
  derived from your password (PBKDF2). The password unlocks the app each launch;
  it never leaves the device.
- Joining a Keep is a **challenge/response**: the Keep sends a nonce, the client
  signs it with the private key, the Keep verifies the signature. The private key
  never leaves the client.

## Transport

- **Classic transport (HTTP/WebSocket):** plaintext by default on a LAN. An owner
  can enable **TLS** (HTTPS/WSS) with their own certificate, or front the Keep
  with a reverse proxy / Cloudflare tunnel that terminates TLS.
- **Peer-to-peer transport (optional):** the entire API + realtime gateway tunnel
  over a **WebRTC data channel**, which is **DTLS-encrypted** with no certificate
  authority involved. Instead of a CA, the Keep **signs its DTLS fingerprint with
  its own Ed25519 identity key**; the client verifies that signature against the
  key it learned from the invite and **refuses the connection on a mismatch** —
  blocking a man-in-the-middle. Sessions use **ephemeral keys (forward secrecy)**.
- **Privacy topology:** clients connect only to the Keep, never directly to each
  other, so members never learn each other's IP addresses. Only the Keep's
  address is exposed, and only to people who hold an invite. An owner can
  optionally route all traffic through their **own TURN relay** ("force relay")
  so members see the relay's IP and never the Keep's home IP.

## What the Keep owner can see

**Everything sent to their Keep:** message text, attachments, profile data, and
voice audio (the Keep is the voice SFU, so audio is decrypted there to be
forwarded). Transport encryption protects content from *outsiders* on the
network — not from the *owner*, who operates the server.

This is intentional. Reliquary is not a zero-knowledge or end-to-end-encrypted
messenger; it's a server **you choose to trust**, run by a person or community.
Don't send a Keep anything you wouldn't want its operator to read.

## Server controls (the host console)

A Keep operator has a host console (authenticated by a key shown once on first
boot, stored only as a hash) with:

- **Revoke a user's sessions** — instantly invalidates their tokens *and*
  force-drops their live connections, requiring them to re-prove key ownership.
  Useful if a token leaks. The account survives; the user can rejoin.
- **Remove a user**, assign roles, set a keep-wide join password, require invites.
- **Per-session activity logging** to the Keep's console for breach forensics.

## Invites

Invite codes are **bearer credentials** — anyone holding the full code can join.
The code is encrypted so the Keep's address isn't legible at a glance (it's not a
secret-keeping measure, just so screenshots/logs don't leak where the server is).
Share them like passwords. Owners can set invites to expire or be single-use, and
revoke them.

## Encryption at rest (planned)

Today, a Keep stores messages and media **unencrypted on the owner's disk**. An
opt-in, owner-controlled **AES-256-GCM at-rest** layer is planned. Until it ships,
treat the Keep's disk as readable by anyone with access to that machine.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.
Email **henry.pelto00@gmail.com** with details and steps to reproduce. We'll
acknowledge and work on a fix before any public disclosure.
