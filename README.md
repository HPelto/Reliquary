# ◆ Reliquary

**Your worlds, your servers, your relic.** A gaming-first, self-hostable communication
client — voice, text, channels, and presence on infrastructure you own, with no
platform sitting in the middle.

## ⬇ Download

**→ [Download Reliquary for Windows](https://hpelto.github.io/Reliquary/)**

That page always serves the latest installer. Or grab it directly:
[**ReliquarySetup.exe**](https://github.com/HPelto/Reliquary/releases/latest/download/ReliquarySetup.exe)

The installer fetches the latest client from the source and **verifies its SHA-512
checksum before running** — a tampered download is refused. Updates then land
automatically from inside the app.

> Windows 10/11, pre-alpha. Linux & macOS clients are planned.

## What it is

- **Client** — an Electron + React desktop app: identity, multi-server connect, text
  chat, channels, roles, invites, profiles, presence, and **voice** (a built-in SFU).
- **Keep** — the self-hostable server: one static Go binary + a SQLite file, no external
  dependencies. Your hardware, your rules. See [`keep/README.md`](keep/README.md) to run one.

## Privacy

Reliquary is decentralized: when you join a Keep you connect **directly** to whoever
hosts it, so that host can see the network address you connect from — like any server
you've ever joined. Other members cannot (voice is forwarded by the Keep, never
peer-to-peer). To mask your address, use a VPN and only join Keeps you trust. Full
notes: [Privacy & your network address](keep/README.md#privacy--your-network-address).

## Building from source

```sh
# client (dev)
npm install && npm run dev
# keep (server)
cd keep && go run ./cmd/keep -name "My Keep"
```

---

Built for the community. ◆
