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
