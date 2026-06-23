package rtc

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// TestTunnelServesHTTP stands up a real pion peer connection (offerer) against
// the Tunnel (answerer) over loopback, opens the data channel, and verifies that
// framed requests reach the handler and responses come back — method, path,
// headers, body, status, multiplexing, and a multi-chunk payload all intact.
func TestTunnelServesHTTP(t *testing.T) {
	const bigSize = 200 * 1024 // > maxChunk → forces chunking + reassembly both ways
	big := strings.Repeat("R", bigSize)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/reliquary":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"protocol":"relic.v1"}`))
		case "/echo":
			body, _ := io.ReadAll(r.Body)
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte("got:" + r.Header.Get("X-Test") + ":" + r.Method + ":" + string(body)))
		case "/big":
			body, _ := io.ReadAll(r.Body) // large request body too
			_, _ = w.Write([]byte(string(body) + big))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	tun := New(handler, nil)

	client, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("client pc: %v", err)
	}
	defer client.Close()

	dc, err := client.CreateDataChannel(label, nil)
	if err != nil {
		t.Fatalf("data channel: %v", err)
	}
	// the client uses the same chunk session as the server
	sess := newSession(dc)
	responses := make(chan wireResponse, 8)
	sess.onMessage = func(data []byte) {
		var resp wireResponse
		if json.Unmarshal(data, &resp) == nil {
			responses <- resp
		}
	}
	dc.OnMessage(func(msg webrtc.DataChannelMessage) { sess.receive(msg.Data) })
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })

	offer, err := client.CreateOffer(nil)
	if err != nil {
		t.Fatalf("offer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(client)
	if err := client.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local: %v", err)
	}
	<-gathered

	answer, err := tun.Answer(*client.LocalDescription())
	if err != nil {
		t.Fatalf("answer: %v", err)
	}
	if err := client.SetRemoteDescription(*answer); err != nil {
		t.Fatalf("set remote: %v", err)
	}

	select {
	case <-opened:
	case <-time.After(15 * time.Second):
		t.Fatal("data channel never opened (ICE failed?)")
	}

	send := func(req wireRequest) wireResponse {
		data, _ := json.Marshal(req)
		if err := sess.send(data); err != nil {
			t.Fatalf("send: %v", err)
		}
		select {
		case resp := <-responses:
			return resp
		case <-time.After(8 * time.Second):
			t.Fatalf("no response for id %d", req.ID)
			return wireResponse{}
		}
	}

	// 1) a plain GET tunnels through to the handler, content-type propagates
	r1 := send(wireRequest{ID: 1, Method: "GET", Path: "/.well-known/reliquary"})
	if r1.ID != 1 || r1.Status != 200 || !strings.Contains(string(r1.Body), "relic.v1") {
		t.Fatalf("discovery: id=%d status=%d body=%q", r1.ID, r1.Status, r1.Body)
	}
	if r1.Headers["Content-Type"] != "application/json" {
		t.Fatalf("content-type not propagated: %v", r1.Headers)
	}

	// 2) method + header + body survive the round trip; status preserved
	r2 := send(wireRequest{
		ID: 2, Method: "POST", Path: "/echo",
		Headers: map[string]string{"X-Test": "hi"}, Body: []byte("payload"),
	})
	if r2.ID != 2 || r2.Status != 201 || string(r2.Body) != "got:hi:POST:payload" {
		t.Fatalf("echo: id=%d status=%d body=%q", r2.ID, r2.Status, r2.Body)
	}

	// 3) a 200 KiB request body AND response both chunk + reassemble correctly
	reqBody := strings.Repeat("Q", 100*1024)
	r3 := send(wireRequest{ID: 3, Method: "POST", Path: "/big", Body: []byte(reqBody)})
	if r3.ID != 3 || r3.Status != 200 {
		t.Fatalf("big: id=%d status=%d", r3.ID, r3.Status)
	}
	if want := reqBody + big; string(r3.Body) != want {
		t.Fatalf("big body mismatch: got %d bytes, want %d", len(r3.Body), len(want))
	}

	// 4) unknown route still routes (handler 404, not a transport error)
	if r4 := send(wireRequest{ID: 4, Method: "GET", Path: "/nope"}); r4.Status != 404 {
		t.Fatalf("expected 404, got %d", r4.Status)
	}
}
