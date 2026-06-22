package api_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"reliquary.gg/keep/internal/api"
	"reliquary.gg/keep/internal/gateway"
	"reliquary.gg/keep/internal/store"
)

type identity struct {
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
}

func newIdentity(t *testing.T) identity {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return identity{pub: pub, priv: priv}
}

func (id identity) pubB64() string { return base64.StdEncoding.EncodeToString(id.pub) }

type client struct {
	t     *testing.T
	base  string
	token string
}

func (c *client) do(method, path string, body any, want int) map[string]any {
	c.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			c.t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, c.base+path, &buf)
	if err != nil {
		c.t.Fatal(err)
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != want {
		c.t.Fatalf("%s %s: got %d want %d (body: %v)", method, path, resp.StatusCode, want, out)
	}
	return out
}

// handshake runs the full local-identity flow: challenge → sign → handshake.
func (c *client) handshake(id identity, username, invite string, want int) map[string]any {
	return c.handshakeFull(id, username, invite, "", want)
}

func (c *client) handshakeFull(id identity, username, invite, keepPassword string, want int) map[string]any {
	c.t.Helper()
	ch := c.do("POST", "/v1/auth/challenge", map[string]string{"pubkey": id.pubB64()}, 200)
	nonce := ch["nonce"].(string)
	sig := ed25519.Sign(id.priv, []byte(nonce))
	return c.do("POST", "/v1/auth/handshake", map[string]any{
		"pubkey":        id.pubB64(),
		"nonce":         nonce,
		"signature":     base64.StdEncoding.EncodeToString(sig),
		"profile":       map[string]string{"username": username, "accent": "#3ddcc4"},
		"invite":        invite,
		"keep_password": keepPassword,
	}, want)
}

func (c *client) handshakeFull2(id identity, username, accent, about, status, avatar, background, invite, keepPassword string, want int) map[string]any {
	c.t.Helper()
	ch := c.do("POST", "/v1/auth/challenge", map[string]string{"pubkey": id.pubB64()}, 200)
	nonce := ch["nonce"].(string)
	sig := ed25519.Sign(id.priv, []byte(nonce))
	return c.do("POST", "/v1/auth/handshake", map[string]any{
		"pubkey":    id.pubB64(),
		"nonce":     nonce,
		"signature": base64.StdEncoding.EncodeToString(sig),
		"profile": map[string]string{
			"username": username, "accent": accent, "about": about,
			"status": status, "avatar": avatar, "background": background,
		},
		"invite":        invite,
		"keep_password": keepPassword,
	}, want)
}

func (c *client) putRaw(path, contentType string, body []byte, want int) {
	c.t.Helper()
	req, _ := http.NewRequest("PUT", c.base+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != want {
		c.t.Fatalf("PUT %s: got %d want %d", path, resp.StatusCode, want)
	}
}

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	hub := gateway.NewHub(st)
	ts := httptest.NewServer(api.New(st, hub, api.Config{Name: "Test Keep"}))
	t.Cleanup(ts.Close)
	return ts
}

func TestEndToEnd(t *testing.T) {
	ts := newTestServer(t)

	// discovery is public
	owner := &client{t: t, base: ts.URL}
	disc := owner.do("GET", "/.well-known/reliquary", nil, 200)
	if disc["protocol"] != "relic.v1" {
		t.Fatalf("bad discovery: %v", disc)
	}

	// first identity to handshake claims the keep
	ownerID := newIdentity(t)
	hs := owner.handshake(ownerID, "aria", "", 200)
	owner.token = hs["token"].(string)
	user := hs["user"].(map[string]any)
	if user["role"] != "owner" {
		t.Fatalf("first identity should be owner: %v", hs)
	}
	if user["fingerprint"] == "" || user["accent"] != "#3ddcc4" {
		t.Fatalf("profile not generated from handshake data: %v", user)
	}

	// a new identity without an invite is rejected
	guestID := newIdentity(t)
	guest := &client{t: t, base: ts.URL}
	guest.handshake(guestID, "kade", "", 403)

	// owner mints an invite; guest joins with it
	inv := owner.do("POST", "/v1/invites", map[string]int{"ttl_seconds": 3600, "max_uses": 1}, 201)
	invToken := inv["token"].(string)

	preview := guest.do("GET", "/v1/invites/"+invToken, nil, 200)
	if preview["valid"] != true || preview["name"] != "Test Keep" {
		t.Fatalf("bad invite preview: %v", preview)
	}

	hs2 := guest.handshake(guestID, "kade", invToken, 200)
	guest.token = hs2["token"].(string)

	// max_uses: the same invite cannot admit another new identity
	third := &client{t: t, base: ts.URL}
	third.handshake(newIdentity(t), "mira", invToken, 403)

	// returning identity needs no invite — the key IS the account
	relog := guest.handshake(guestID, "kade", "", 200)
	if relog["token"] == "" {
		t.Fatal("returning handshake returned no token")
	}

	// renaming flows through the handshake profile
	renamed := guest.handshake(guestID, "kade-the-bold", "", 200)
	if renamed["user"].(map[string]any)["username"] != "kade-the-bold" {
		t.Fatalf("profile update did not apply: %v", renamed)
	}

	// signature from the wrong key is rejected
	wrongKey := newIdentity(t)
	ch := guest.do("POST", "/v1/auth/challenge", map[string]string{"pubkey": guestID.pubB64()}, 200)
	nonce := ch["nonce"].(string)
	badSig := ed25519.Sign(wrongKey.priv, []byte(nonce))
	guestNoAuth := &client{t: t, base: ts.URL}
	guestNoAuth.do("POST", "/v1/auth/handshake", map[string]any{
		"pubkey":    guestID.pubB64(),
		"nonce":     nonce,
		"signature": base64.StdEncoding.EncodeToString(badSig),
		"profile":   map[string]string{"username": "kade"},
	}, 401)

	// a nonce cannot be replayed (the bad attempt above consumed it)
	goodSig := ed25519.Sign(guestID.priv, []byte(nonce))
	guestNoAuth.do("POST", "/v1/auth/handshake", map[string]any{
		"pubkey":    guestID.pubB64(),
		"nonce":     nonce,
		"signature": base64.StdEncoding.EncodeToString(goodSig),
		"profile":   map[string]string{"username": "kade"},
	}, 401)

	// guest connects to the gateway and should receive broadcasts
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	wsURL := strings.Replace(ts.URL, "http://", "ws://", 1) + "/v1/gateway?token=" + guest.token
	ws, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "done")

	var hello gateway.Event
	if err := wsjson.Read(ctx, ws, &hello); err != nil || hello.T != "HELLO" {
		t.Fatalf("expected HELLO, got %v (err %v)", hello, err)
	}

	// world reflects channels, members, and presence
	world := owner.do("GET", "/v1/world", nil, 200)
	channels := world["channels"].([]any)
	if len(channels) != 3 {
		t.Fatalf("expected 3 seeded channels, got %d", len(channels))
	}
	if len(world["members"].([]any)) != 2 {
		t.Fatalf("expected 2 members, got %v", world["members"])
	}
	tavernID := int64(channels[0].(map[string]any)["id"].(float64))

	// owner posts; guest sees it arrive over the gateway
	msg := owner.do("POST", fmt.Sprintf("/v1/channels/%d/messages", tavernID),
		map[string]string{"content": "the keep stands"}, 201)
	if msg["content"] != "the keep stands" {
		t.Fatalf("bad message response: %v", msg)
	}

	deadline := time.After(5 * time.Second)
	for {
		var ev gateway.Event
		readCtx, readCancel := context.WithTimeout(ctx, 5*time.Second)
		err := wsjson.Read(readCtx, ws, &ev)
		readCancel()
		if err != nil {
			t.Fatalf("gateway read: %v", err)
		}
		if ev.T == "MESSAGE_CREATE" {
			d := ev.D.(map[string]any)
			if d["content"] != "the keep stands" {
				t.Fatalf("wrong broadcast content: %v", d)
			}
			if d["author"].(map[string]any)["username"] != "aria" {
				t.Fatalf("broadcast missing author profile: %v", d)
			}
			break
		}
		select {
		case <-deadline:
			t.Fatal("never received MESSAGE_CREATE on gateway")
		default:
		}
	}

	// history pagination returns the message, oldest first
	list := owner.do("GET", fmt.Sprintf("/v1/channels/%d/messages?limit=50", tavernID), nil, 200)
	if len(list["messages"].([]any)) != 1 {
		t.Fatalf("expected 1 message, got %v", list)
	}

	// edit + delete authorization
	msgID := int64(msg["id"].(float64))
	edited := owner.do("PATCH", fmt.Sprintf("/v1/channels/%d/messages/%d", tavernID, msgID),
		map[string]string{"content": "the keep endures"}, 200)
	if edited["content"] != "the keep endures" {
		t.Fatalf("edit didn't apply: %v", edited)
	}
	if edited["edited_at"].(float64) == 0 {
		t.Fatalf("edited_at not stamped: %v", edited)
	}

	// reply: a reply carries a resolved preview of its target; a dangling ref 400s
	reply := owner.do("POST", fmt.Sprintf("/v1/channels/%d/messages", tavernID),
		map[string]any{"content": "couldn't agree more", "reply_to": msgID}, 201)
	if prev, ok := reply["reply_preview"].(map[string]any); !ok || int64(prev["id"].(float64)) != msgID {
		t.Fatalf("reply preview missing/wrong: %v", reply)
	}
	owner.do("POST", fmt.Sprintf("/v1/channels/%d/messages", tavernID),
		map[string]any{"content": "x", "reply_to": 999999}, 400)

	// pin: members can't, owner can; the pins list reflects it
	guest.do("POST", fmt.Sprintf("/v1/channels/%d/messages/%d/pin", tavernID, msgID), nil, 403)
	pinned := owner.do("POST", fmt.Sprintf("/v1/channels/%d/messages/%d/pin", tavernID, msgID), nil, 200)
	if pinned["pinned"] != true {
		t.Fatalf("message not pinned: %v", pinned)
	}
	if pins := owner.do("GET", fmt.Sprintf("/v1/channels/%d/pins", tavernID), nil, 200); len(pins["messages"].([]any)) != 1 {
		t.Fatalf("expected 1 pin, got %v", pins)
	}
	owner.do("DELETE", fmt.Sprintf("/v1/channels/%d/messages/%d/pin", tavernID, msgID), nil, 200)
	if pins := owner.do("GET", fmt.Sprintf("/v1/channels/%d/pins", tavernID), nil, 200); len(pins["messages"].([]any)) != 0 {
		t.Fatalf("expected 0 pins after unpin, got %v", pins)
	}

	// a non-author member can neither edit nor delete someone else's message
	guest.do("PATCH", fmt.Sprintf("/v1/channels/%d/messages/%d", tavernID, msgID),
		map[string]string{"content": "hijack"}, 403)
	guest.do("DELETE", fmt.Sprintf("/v1/channels/%d/messages/%d", tavernID, msgID), nil, 403)
	// the author can delete their own; afterwards it's gone and editing 404s
	owner.do("DELETE", fmt.Sprintf("/v1/channels/%d/messages/%d", tavernID, msgID), nil, 200)
	gone := owner.do("GET", fmt.Sprintf("/v1/channels/%d/messages?limit=50", tavernID), nil, 200)
	for _, m := range gone["messages"].([]any) {
		if int64(m.(map[string]any)["id"].(float64)) == msgID {
			t.Fatalf("message should be deleted, still present: %v", gone)
		}
	}
	owner.do("PATCH", fmt.Sprintf("/v1/channels/%d/messages/%d", tavernID, msgID),
		map[string]string{"content": "ghost"}, 404)

	// attachments must reference already-uploaded media; empty + no media is rejected
	owner.do("POST", fmt.Sprintf("/v1/channels/%d/messages", tavernID),
		map[string]any{"attachments": []map[string]any{{"hash": "deadbeef", "name": "x.png", "content_type": "image/png"}}}, 400)
	owner.do("POST", fmt.Sprintf("/v1/channels/%d/messages", tavernID),
		map[string]string{"content": "   "}, 400)

	// members may not mint invites
	guest.do("POST", "/v1/invites", map[string]int{}, 403)

	// posting to a voice channel is rejected
	warRoomID := int64(channels[2].(map[string]any)["id"].(float64))
	owner.do("POST", fmt.Sprintf("/v1/channels/%d/messages", warRoomID),
		map[string]string{"content": "hello?"}, 400)
}

func TestAdmin(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.SetSetting(api.SettingAdminKeyHash, api.HashAdminKey("test-admin-key")); err != nil {
		t.Fatal(err)
	}
	hub := gateway.NewHub(st)
	ts := httptest.NewServer(api.New(st, hub, api.Config{Name: "Test Keep"}))
	t.Cleanup(ts.Close)

	// claim the keep so invite minting has an owner to attribute to
	owner := &client{t: t, base: ts.URL}
	hs := owner.handshake(newIdentity(t), "aria", "", 200)
	owner.token = hs["token"].(string)

	adminDo := func(method, path string, body any, key string, want int) map[string]any {
		t.Helper()
		var buf bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&buf).Encode(body)
		}
		req, _ := http.NewRequest(method, ts.URL+path, &buf)
		if key != "" {
			req.Header.Set("X-Admin-Key", key)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		if resp.StatusCode != want {
			t.Fatalf("%s %s: got %d want %d (body: %v)", method, path, resp.StatusCode, want, out)
		}
		return out
	}

	// wrong/missing key is rejected; right key works
	adminDo("GET", "/v1/admin/state", nil, "", 403)
	adminDo("GET", "/v1/admin/state", nil, "wrong-key", 403)
	state := adminDo("GET", "/v1/admin/state", nil, "test-admin-key", 200)
	if state["name"] != "Test Keep" || len(state["channels"].([]any)) != 3 {
		t.Fatalf("bad admin state: %v", state)
	}

	// an owner bearer token also passes the admin gate
	ownerReq, _ := http.NewRequest("GET", ts.URL+"/v1/admin/state", nil)
	ownerReq.Header.Set("Authorization", "Bearer "+owner.token)
	resp, err := http.DefaultClient.Do(ownerReq)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("owner token should pass admin gate, got %d", resp.StatusCode)
	}

	// rename the instance — discovery reflects it
	adminDo("PATCH", "/v1/admin/settings", map[string]string{"name": "Murkwater Keep"}, "test-admin-key", 200)
	disc := owner.do("GET", "/.well-known/reliquary", nil, 200)
	if disc["instance"].(map[string]any)["name"] != "Murkwater Keep" {
		t.Fatalf("rename did not reach discovery: %v", disc)
	}

	// channel lifecycle: create (name cleaning), rename, delete
	ch := adminDo("POST", "/v1/admin/channels", map[string]string{"name": "Raid Plans", "kind": "text"}, "test-admin-key", 201)
	if ch["name"] != "raid-plans" {
		t.Fatalf("channel name not cleaned: %v", ch)
	}
	chID := int64(ch["id"].(float64))
	adminDo("PATCH", fmt.Sprintf("/v1/admin/channels/%d", chID), map[string]string{"name": "war-plans"}, "test-admin-key", 200)
	adminDo("DELETE", fmt.Sprintf("/v1/admin/channels/%d", chID), nil, "test-admin-key", 200)
	adminDo("DELETE", "/v1/admin/channels/99999", nil, "test-admin-key", 404)

	// invite lifecycle: mint via admin key, revoke, redeemed-after-revoke fails
	inv := adminDo("POST", "/v1/admin/invites", map[string]int{"ttl_seconds": 3600, "max_uses": 1}, "test-admin-key", 201)
	token := inv["token"].(string)
	adminDo("DELETE", "/v1/admin/invites/"+token, nil, "test-admin-key", 200)
	late := &client{t: t, base: ts.URL}
	late.handshake(newIdentity(t), "sneaky", token, 403)
}

func TestHostAndKeepPassword(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.SetSetting(api.SettingAdminKeyHash, api.HashAdminKey("host-key")); err != nil {
		t.Fatal(err)
	}
	hub := gateway.NewHub(st)
	ts := httptest.NewServer(api.New(st, hub, api.Config{Name: "Test Keep"}))
	t.Cleanup(ts.Close)

	hostDo := func(method, path string, body any, key string, want int) map[string]any {
		t.Helper()
		var buf bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&buf).Encode(body)
		}
		req, _ := http.NewRequest(method, ts.URL+path, &buf)
		if key != "" {
			req.Header.Set("X-Admin-Key", key)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		if resp.StatusCode != want {
			t.Fatalf("%s %s: got %d want %d (body: %v)", method, path, resp.StatusCode, want, out)
		}
		return out
	}

	// owner claims the keep
	owner := &client{t: t, base: ts.URL}
	ownerID := newIdentity(t)
	hs := owner.handshake(ownerID, "aria", "", 200)
	owner.token = hs["token"].(string)
	ownerUID := int64(hs["user"].(map[string]any)["id"].(float64))

	// host endpoints reject client tokens — even the owner's
	req, _ := http.NewRequest("GET", ts.URL+"/v1/host/state", nil)
	req.Header.Set("Authorization", "Bearer "+owner.token)
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("owner token must NOT pass the host gate, got %d", resp.StatusCode)
	}
	hostDo("GET", "/v1/host/state", nil, "host-key", 200)

	// keep password gate: set it, then a new identity must present it
	hostDo("POST", "/v1/host/keep-password", map[string]string{"password": "trust-no-one"}, "host-key", 200)
	inv := owner.do("POST", "/v1/invites", map[string]int{"ttl_seconds": 3600}, 201)
	invToken := inv["token"].(string)

	guestID := newIdentity(t)
	guest := &client{t: t, base: ts.URL}
	// invite alone is not enough anymore
	guest.handshakeFull(guestID, "kade", invToken, "", 403)
	guest.handshakeFull(guestID, "kade", invToken, "wrong-password", 403)
	hs2 := guest.handshakeFull(guestID, "kade", invToken, "trust-no-one", 200)
	guest.token = hs2["token"].(string)
	guestUID := int64(hs2["user"].(map[string]any)["id"].(float64))

	// returning identities are gated too
	guest.handshakeFull(guestID, "kade", "", "", 403)
	guest.handshakeFull(guestID, "kade", "", "trust-no-one", 200)

	// clearing the gate reopens normal flow
	hostDo("POST", "/v1/host/keep-password", map[string]string{"password": ""}, "host-key", 200)
	guest.handshakeFull(guestID, "kade", "", "", 200)

	// roles: member cannot manage; host promotes to admin; then they can
	guest.do("POST", "/v1/admin/channels", map[string]string{"name": "nope", "kind": "text"}, 403)
	hostDo("PATCH", fmt.Sprintf("/v1/host/users/%d", guestUID), map[string]string{"role": "admin"}, "host-key", 200)
	guest.do("POST", "/v1/admin/channels", map[string]string{"name": "admin-made", "kind": "text"}, 201)
	guest.do("POST", "/v1/invites", map[string]int{"ttl_seconds": 60}, 201)

	// rescue flow: remove a user, mint a rescue invite, rejoin with a new key
	hostDo("DELETE", fmt.Sprintf("/v1/host/users/%d", guestUID), nil, "host-key", 200)
	rescue := hostDo("POST", "/v1/host/rescue-invite", nil, "host-key", 201)
	newKade := newIdentity(t)
	fresh := &client{t: t, base: ts.URL}
	fresh.handshake(newKade, "kade-reborn", rescue["token"].(string), 200)

	// addr config stores and validates
	hostDo("POST", "/v1/host/addr", map[string]string{"addr": ":9001"}, "host-key", 200)
	hostDo("POST", "/v1/host/addr", map[string]string{"addr": "not-a-port"}, "host-key", 400)
	if got, _ := st.GetSetting(api.SettingAddr); got != ":9001" {
		t.Fatalf("addr setting not stored, got %q", got)
	}

	// TLS config: enabling needs both paths and a cert that actually loads;
	// disabling clears the flag; default state is off.
	hostDo("POST", "/v1/host/tls", map[string]any{"enabled": true}, "host-key", 400)
	hostDo("POST", "/v1/host/tls", map[string]any{"enabled": true, "cert_path": "/no/such/cert.pem", "key_path": "/no/such/key.pem"}, "host-key", 400)
	hostDo("POST", "/v1/host/tls", map[string]any{"enabled": false, "cert_path": "/some/cert.pem", "key_path": "/some/key.pem"}, "host-key", 200)
	if got, _ := st.GetSetting(api.SettingTLSEnabled); got != "" {
		t.Fatalf("tls should be disabled, got %q", got)
	}
	if state := hostDo("GET", "/v1/host/state", nil, "host-key", 200); state["tls_enabled"] != false {
		t.Fatalf("tls_enabled should be false, got %v", state["tls_enabled"])
	}

	// restart is gated on a supervisor wiring SetRestart; unset → 501, and
	// host state reflects availability
	state := hostDo("GET", "/v1/host/state", nil, "host-key", 200)
	if state["restart_available"] != false {
		t.Fatalf("restart should be unavailable without SetRestart: %v", state["restart_available"])
	}
	hostDo("POST", "/v1/host/restart", nil, "host-key", 501)
	if state["update_available"] != false {
		t.Fatalf("update should be unavailable without SetUpdateRestart: %v", state["update_available"])
	}
	hostDo("POST", "/v1/host/update-restart", nil, "host-key", 501)

	_ = ownerUID
}

func TestRestartWiring(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.SetSetting(api.SettingAdminKeyHash, api.HashAdminKey("host-key")); err != nil {
		t.Fatal(err)
	}
	hub := gateway.NewHub(st)
	srv := api.New(st, hub, api.Config{Name: "Test Keep"})
	fired := make(chan struct{}, 1)
	srv.SetRestart(func() { fired <- struct{}{} })
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest("POST", ts.URL+"/v1/host/restart", nil)
	req.Header.Set("X-Admin-Key", "host-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("restart should be 200 when wired, got %d", resp.StatusCode)
	}
	select {
	case <-fired:
	case <-time.After(2 * time.Second):
		t.Fatal("restart callback never fired")
	}

	// update-restart fires its own callback when wired
	updated := make(chan struct{}, 1)
	srv.SetUpdateRestart(func() { updated <- struct{}{} })
	ureq, _ := http.NewRequest("POST", ts.URL+"/v1/host/update-restart", nil)
	ureq.Header.Set("X-Admin-Key", "host-key")
	uresp, err := http.DefaultClient.Do(ureq)
	if err != nil {
		t.Fatal(err)
	}
	uresp.Body.Close()
	if uresp.StatusCode != 200 {
		t.Fatalf("update-restart should be 200 when wired, got %d", uresp.StatusCode)
	}
	select {
	case <-updated:
	case <-time.After(2 * time.Second):
		t.Fatal("update-restart callback never fired")
	}
}

func TestCORSAllowsMediaUpload(t *testing.T) {
	ts := newTestServer(t)
	// the browser preflights the avatar PUT — Allow-Methods must include PUT,
	// or uploads are blocked and avatars never reach the keep
	req, _ := http.NewRequest("OPTIONS", ts.URL+"/v1/media/abc", nil)
	req.Header.Set("Origin", "app://reliquary")
	req.Header.Set("Access-Control-Request-Method", "PUT")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	allow := resp.Header.Get("Access-Control-Allow-Methods")
	for _, m := range []string{"PUT", "PATCH", "DELETE", "POST", "GET"} {
		if !strings.Contains(allow, m) {
			t.Fatalf("CORS Allow-Methods missing %s: %q", m, allow)
		}
	}
}

func TestProfileAndMedia(t *testing.T) {
	ts := newTestServer(t)
	owner := &client{t: t, base: ts.URL}
	ownerID := newIdentity(t)

	// handshake carries the rich profile fields
	hs := owner.handshakeFull2(ownerID, "aria", "#3ddcc4", "deploying democracy", "online", "", "", "", "", 200)
	owner.token = hs["token"].(string)
	u := hs["user"].(map[string]any)
	if u["about"] != "deploying democracy" || u["status"] != "online" {
		t.Fatalf("profile fields not stored on handshake: %v", u)
	}

	// upload a tiny gif as an avatar — content-addressed
	gif := []byte("GIF89a\x01\x00\x01\x00\x00\xff\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x00;")
	sum := sha256.Sum256(gif)
	hash := hex.EncodeToString(sum[:])

	exists := owner.do("GET", "/v1/media/"+hash+"/exists", nil, 200)
	if exists["exists"] != false {
		t.Fatal("media should not exist yet")
	}

	// wrong-hash upload is rejected
	owner.putRaw("/v1/media/"+strings.Repeat("0", 64), "image/gif", gif, 400)
	// correct upload
	owner.putRaw("/v1/media/"+hash, "image/gif", gif, 201)
	// non-image rejected
	owner.putRaw("/v1/media/"+hash, "text/plain", []byte("nope"), 415)

	exists = owner.do("GET", "/v1/media/"+hash+"/exists", nil, 200)
	if exists["exists"] != true {
		t.Fatal("media should exist after upload")
	}

	// public GET returns the exact bytes with the right content-type
	resp, err := http.Get(ts.URL + "/v1/media/" + hash)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/gif" || !bytes.Equal(got, gif) {
		t.Fatalf("media GET wrong: status=%d ct=%s len=%d", resp.StatusCode, resp.Header.Get("Content-Type"), len(got))
	}

	// PATCH profile live → reflected in world, broadcast to a listener
	guestID := newIdentity(t)
	inv := owner.do("POST", "/v1/invites", map[string]int{"ttl_seconds": 3600}, 201)
	guest := &client{t: t, base: ts.URL}
	ghs := guest.handshake(guestID, "kade", inv["token"].(string), 200)
	guest.token = ghs["token"].(string)

	owner.do("PATCH", "/v1/profile",
		map[string]string{"username": "aria", "accent": "#3ddcc4", "about": "for super earth", "status": "in a dive", "avatar": hash, "background": "", "name_color": "#ff6b81"}, 200)

	world := guest.do("GET", "/v1/world", nil, 200)
	var ariaSeen map[string]any
	for _, m := range world["members"].([]any) {
		mm := m.(map[string]any)
		if mm["username"] == "aria" {
			ariaSeen = mm
		}
	}
	if ariaSeen == nil || ariaSeen["about"] != "for super earth" || ariaSeen["avatar"] != hash {
		t.Fatalf("patched profile not visible to other members: %v", ariaSeen)
	}
	if ariaSeen["name_color"] != "#ff6b81" {
		t.Fatalf("name_color not synced: %v", ariaSeen["name_color"])
	}
	// bad name_color is rejected
	owner.do("PATCH", "/v1/profile",
		map[string]string{"username": "aria", "accent": "#3ddcc4", "name_color": "magenta"}, 400)
}

func TestEvents(t *testing.T) {
	ts := newTestServer(t)
	owner := &client{t: t, base: ts.URL}
	hs := owner.handshake(newIdentity(t), "aria", "", 200)
	owner.token = hs["token"].(string)

	// a member (non-manager) joins
	inv := owner.do("POST", "/v1/invites", map[string]int{"ttl_seconds": 3600}, 201)
	member := &client{t: t, base: ts.URL}
	mhs := member.handshake(newIdentity(t), "kade", inv["token"].(string), 200)
	member.token = mhs["token"].(string)

	// find the seeded voice channel
	world := owner.do("GET", "/v1/world", nil, 200)
	var voiceID int64
	for _, c := range world["channels"].([]any) {
		cc := c.(map[string]any)
		if cc["kind"] == "voice" {
			voiceID = int64(cc["id"].(float64))
		}
	}
	if voiceID == 0 {
		t.Fatal("no seeded voice channel")
	}
	soon := time.Now().Add(time.Hour).UnixMilli()

	// members can't create events
	member.do("POST", "/v1/events", map[string]any{
		"title": "nope", "location_kind": "voice", "channel_id": voiceID, "starts_at": soon,
	}, 403)

	// end before start is rejected
	owner.do("POST", "/v1/events", map[string]any{
		"title": "backwards", "location_kind": "voice", "channel_id": voiceID,
		"starts_at": soon, "ends_at": soon - 1000,
	}, 400)

	// owner creates a voice event with an end time
	ends := soon + time.Hour.Milliseconds()
	ev := owner.do("POST", "/v1/events", map[string]any{
		"title": "Raid Night", "description": "bring stims", "location_kind": "voice",
		"channel_id": voiceID, "starts_at": soon, "ends_at": ends, "frequency": "weekly",
	}, 201)
	if ev["title"] != "Raid Night" || ev["location_kind"] != "voice" {
		t.Fatalf("bad event: %v", ev)
	}
	if int64(ev["ends_at"].(float64)) != ends {
		t.Fatalf("ends_at not stored: %v", ev["ends_at"])
	}
	evID := int64(ev["id"].(float64))

	// invalid: voice kind with a non-voice / missing channel
	owner.do("POST", "/v1/events", map[string]any{
		"title": "bad", "location_kind": "voice", "channel_id": 99999, "starts_at": soon,
	}, 400)

	// "somewhere else" event
	owner.do("POST", "/v1/events", map[string]any{
		"title": "IRL meetup", "location_kind": "other", "location_text": "the pub", "starts_at": soon,
	}, 201)

	// members can list; events appear in the world too
	list := member.do("GET", "/v1/events", nil, 200)
	if len(list["events"].([]any)) != 2 {
		t.Fatalf("expected 2 events, got %v", list["events"])
	}
	world = member.do("GET", "/v1/world", nil, 200)
	if len(world["events"].([]any)) != 2 {
		t.Fatalf("world should carry events: %v", world["events"])
	}

	// members can't delete; owner can
	member.do("DELETE", fmt.Sprintf("/v1/events/%d", evID), nil, 403)
	owner.do("DELETE", fmt.Sprintf("/v1/events/%d", evID), nil, 200)
	owner.do("DELETE", fmt.Sprintf("/v1/events/%d", evID), nil, 404)
	list = owner.do("GET", "/v1/events", nil, 200)
	if len(list["events"].([]any)) != 1 {
		t.Fatalf("expected 1 event after delete, got %v", list["events"])
	}
}

func TestNameStyleLock(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.SetSetting(api.SettingAdminKeyHash, api.HashAdminKey("host-key")); err != nil {
		t.Fatal(err)
	}
	hub := gateway.NewHub(st)
	ts := httptest.NewServer(api.New(st, hub, api.Config{Name: "Test Keep"}))
	t.Cleanup(ts.Close)

	owner := &client{t: t, base: ts.URL}
	hs := owner.handshake(newIdentity(t), "aria", "", 200)
	owner.token = hs["token"].(string)

	// default: unlocked
	world := owner.do("GET", "/v1/world", nil, 200)
	if world["lock_name_style"] != false {
		t.Fatalf("expected unlocked by default: %v", world["lock_name_style"])
	}

	// owner locks via partial settings patch (name omitted)
	owner.do("PATCH", "/v1/admin/settings", map[string]any{"lock_name_style": true}, 200)
	world = owner.do("GET", "/v1/world", nil, 200)
	if world["lock_name_style"] != true {
		t.Fatalf("lock flag did not flip: %v", world["lock_name_style"])
	}
	// name unchanged by the lock-only patch
	if world["name"] != "Test Keep" {
		t.Fatalf("partial patch clobbered the name: %v", world["name"])
	}

	// unlock again
	owner.do("PATCH", "/v1/admin/settings", map[string]any{"lock_name_style": false}, 200)
	world = owner.do("GET", "/v1/world", nil, 200)
	if world["lock_name_style"] != false {
		t.Fatalf("lock flag did not clear: %v", world["lock_name_style"])
	}
}

func TestRequireInviteToggle(t *testing.T) {
	ts := newTestServer(t)
	owner := &client{t: t, base: ts.URL}
	hs := owner.handshake(newIdentity(t), "aria", "", 200)
	owner.token = hs["token"].(string)

	// default: invites required
	world := owner.do("GET", "/v1/world", nil, 200)
	if world["require_invite"] != true {
		t.Fatalf("expected require_invite true by default: %v", world["require_invite"])
	}
	// a new identity without an invite is rejected
	(&client{t: t, base: ts.URL}).handshake(newIdentity(t), "kade", "", 403)

	// owner turns the requirement off (partial patch; name omitted)
	owner.do("PATCH", "/v1/admin/settings", map[string]any{"require_invite": false}, 200)
	world = owner.do("GET", "/v1/world", nil, 200)
	if world["require_invite"] != false {
		t.Fatalf("require_invite did not clear: %v", world["require_invite"])
	}
	if world["name"] != "Test Keep" {
		t.Fatalf("partial patch clobbered the name: %v", world["name"])
	}
	// now a fresh identity joins with NO invite
	open := &client{t: t, base: ts.URL}
	openHS := open.handshake(newIdentity(t), "rune", "", 200)
	if openHS["user"].(map[string]any)["role"] != "member" {
		t.Fatalf("open joiner should be a member: %v", openHS)
	}

	// an unused one-time invite must NOT be consumed by an open join
	inv := owner.do("POST", "/v1/invites", map[string]int{"ttl_seconds": 3600, "max_uses": 1}, 201)
	invToken := inv["token"].(string)
	(&client{t: t, base: ts.URL}).handshake(newIdentity(t), "echo", "", 200) // open join, no invite
	preview := owner.do("GET", "/v1/invites/"+invToken, nil, 200)
	if preview["valid"] != true {
		t.Fatalf("open join should not have consumed the invite: %v", preview)
	}

	// turning it back on restores the wall
	owner.do("PATCH", "/v1/admin/settings", map[string]any{"require_invite": true}, 200)
	(&client{t: t, base: ts.URL}).handshake(newIdentity(t), "vale", "", 403)

	// the LAN-address hint endpoint responds for the owner
	addrs := owner.do("GET", "/v1/admin/net-addresses", nil, 200)
	if _, ok := addrs["candidates"]; !ok {
		t.Fatalf("net-addresses missing candidates: %v", addrs)
	}
	if _, ok := addrs["port"]; !ok {
		t.Fatalf("net-addresses missing port: %v", addrs)
	}
}

func TestInviteExpiry(t *testing.T) {
	ts := newTestServer(t)
	owner := &client{t: t, base: ts.URL}
	hs := owner.handshake(newIdentity(t), "aria", "", 200)
	owner.token = hs["token"].(string)

	inv := owner.do("POST", "/v1/invites", map[string]int{"ttl_seconds": 1}, 201)
	invToken := inv["token"].(string)

	time.Sleep(1100 * time.Millisecond)

	preview := owner.do("GET", "/v1/invites/"+invToken, nil, 200)
	if preview["valid"] != false {
		t.Fatalf("invite should have expired: %v", preview)
	}

	late := &client{t: t, base: ts.URL}
	late.handshake(newIdentity(t), "kade", invToken, 403)
}
