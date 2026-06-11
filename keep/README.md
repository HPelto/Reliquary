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
