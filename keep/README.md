# Reliquary Keep

The self-hostable Reliquary dedicated server. One static binary, one SQLite
file, no external dependencies. Your hardware, your rules.

## Run

```sh
go run ./cmd/keep -name "My Keep"
# or build a binary
go build -o keep ./cmd/keep && ./keep -addr :7777 -data keep.db -name "My Keep"
# or docker
docker compose up
```

## Networking & port forwarding

Only the **Keep** needs to be reachable — the client connects *outbound* and
needs nothing forwarded. To let friends join over the internet, forward these
ports on your router to the machine running the Keep:

| Port     | Protocol | Carries                                                                          | Flag (default)    |
| -------- | -------- | -------------------------------------------------------------------------------- | ----------------- |
| **7777** | **TCP**  | Everything: discovery, handshake, chat, presence, media, the gateway WebSocket, and `/admin` | `-addr :7777`     |
| **7011** | **UDP**  | Voice (the SFU — Opus audio)                                                     | `-voice-port 7011` |

- **Text/chat only** → forward **TCP 7777**.
- **Voice too** → also forward **UDP 7011**.

### Voice across the internet (behind a home router / NAT)

Forwarding UDP 7011 isn't enough by itself: by default the voice server only
advertises its **LAN** address (e.g. `192.168.x.x`), which remote friends can't
reach. Tell it your **public IP** so it advertises a reachable address:

```sh
./keep -voice-ip <your-public-ip>     # or: set VOICE_PUBLIC_IP=<your-public-ip>
```

(Find your public IP at e.g. whatismyip.com. On the same LAN, voice works
without this.)

### Custom ports

Both are configurable — if you change them, forward the values you set:

```sh
./keep -addr :8443 -voice-port 9000
```

> The `/admin` host console is on the same TCP port (`http://localhost:7777/admin`),
> gated by the host key. Use it **locally**; don't expose it publicly without TLS.

## Encryption (TLS) — optional

A Keep runs **plain `ws://`/`http://` by default** — zero setup, which keeps
self-hosting accessible. Traffic (including your messages and session token) is
then unencrypted on the network path, so on an untrusted network anyone in the
middle could read it. If that matters to you, turn TLS on; you have two ways:

**1. From the Host Console (recommended).** Open `/admin` → **TLS / encryption**,
tick *Enable TLS*, enter the paths to your certificate and private key (PEM files
on the Keep machine), Save, then **Restart**. The Keep comes back on `https`/`wss`.
If the cert can't be loaded it falls back to plain http and logs why, so a typo
can never lock you out of the console.

**2. At launch.** Pass the cert and key as flags:

```sh
./keep -tls-cert /path/to/fullchain.pem -tls-key /path/to/privkey.pem
```

Either way, clients reach a TLS Keep with an `https://` address (e.g.
`https://keep.example` behind a proxy on 443, or `https://keep.example:8443` for
TLS directly on another port). Get a certificate from **Let's Encrypt** (free) or
use a self-signed one for a private group.

**Or terminate TLS with a reverse proxy.** Putting **Caddy**, **nginx**, or
**Cloudflare** in front (TLS on :443 → forwarding to the Keep on :7777) works
without any Keep-side cert config — clients just use `https://your-domain`. Caddy
example:

```
keep.example {
    reverse_proxy localhost:7777
}
```

## Privacy & your network address

Reliquary is **decentralized and self-hosted** — there's no company server sitting
between you and a Keep. When you join one, your client connects *directly* to the
machine running that Keep, exactly like connecting to any website or game server.

**What this means for your public IP:**

- **The Keep's owner can see the IP address you connect from.** This is inherent to
  connecting directly to someone's server — it's true of every server you've ever
  joined. Reliquary itself does **not** collect, log, store, or display anyone's IP
  anywhere in the app or admin console, but the operator of any server can observe
  the addresses connecting to their own machine at the network level. We can't
  cryptographically hide that, and we won't pretend to.
- **Other members of a Keep cannot see your IP.** Voice runs through the Keep as a
  selective forwarder (SFU), so audio never flows peer-to-peer — the people in your
  voice channel never learn your address. Only the Keep's operator can.

**How to protect yourself** (standard, common-sense decentralization hygiene):

- **Only join Keeps run by people you trust.** A public IP can be abused (e.g. for
  DDoS), so treat joining a stranger's Keep like handing them your address — because
  you are.
- **Use a VPN** if you want to mask your real IP from Keep operators. Routing your
  connection through a VPN means a Keep only ever sees the VPN's address, not yours.
  This is the most effective way to stay anonymous on a self-hosted network.

This is the trade that comes with owning your own infrastructure instead of renting
a big platform's: no middleman harvesting your data, but also no middleman shielding
your address. On open, decentralized software, protecting yourself is ultimately in
your own hands — and a VPN puts it there.

## Identity model

Accounts are **client-owned**. There is no registration, no email, no
password. The client forges an Ed25519 keypair locally during onboarding;
joining a Keep is a signed handshake, and the Keep generates its own local
profile record for that key:

1. `POST /v1/auth/challenge` `{pubkey}` → `{nonce}`
2. the client signs the nonce with its private key
3. `POST /v1/auth/handshake` `{pubkey, nonce, signature, profile: {username, accent}, invite?}` → `{token, user}`

The first identity to complete a handshake claims the Keep and becomes its
owner. New identities after that need an invite (invites expire — default
7 days). Returning identities never need one — the key *is* the account, and
the profile fields refresh from whatever the client presents.

## Protocol (relic.v1)

- `GET /.well-known/reliquary` — discovery: instance name, protocol, API + gateway paths
- `POST /v1/auth/challenge`, `POST /v1/auth/handshake` — see above
- `GET /v1/invites/{token}` — public invite preview (name, member count, validity)
- `GET /v1/world` — channels + members with live presence *(auth)*
- `GET /v1/channels/{id}/messages?limit&before` *(auth)*
- `POST /v1/channels/{id}/messages` `{content}` *(auth)*
- `POST /v1/invites` `{ttl_seconds, max_uses}` *(owner)* — `ttl_seconds: -1` = never expires, `0` = default 7 days
- `GET /v1/gateway?token=…` — WebSocket. Server pushes `{t, d}` envelopes:
  `HELLO`, `MESSAGE_CREATE`, `MEMBER_JOIN`, `MEMBER_UPDATE`, `PRESENCE_UPDATE`, `PONG`

Auth is `Authorization: Bearer <token>`; tokens are stored hashed.

## Test

```sh
go test ./...
```
