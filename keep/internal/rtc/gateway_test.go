package rtc

import (
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// fakeGateway is a stand-in for the Keep's auth + hub bridge. Subscribe accepts
// only the token "good", hands the live push func to the test (so it can drive
// events), and signals when its stop is invoked.
type fakeGateway struct {
	subscribed chan func(string, any) bool
	stopped    chan struct{}
	inbound    chan upstreamFrame
	once       sync.Once
}

func (f *fakeGateway) Subscribe(token string, push func(string, any) bool) (int64, func(), bool) {
	if token != "good" {
		return 0, nil, false
	}
	f.subscribed <- push
	return 42, func() { f.once.Do(func() { close(f.stopped) }) }, true
}

func (f *fakeGateway) HandleInbound(userID int64, t string, d json.RawMessage) {
	if f.inbound != nil {
		f.inbound <- upstreamFrame{T: t, D: d}
	}
}

// TestTunnelGateway verifies the realtime gateway path over the data channel: a
// peer "GET"s /v1/gateway, the Tunnel invokes the Gateway, pushed events arrive
// as ordered gw frames on the client, plain request/response still works on the
// same channel, and the subscription is stopped when the peer closes.
func TestTunnelGateway(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ping" {
			_, _ = w.Write([]byte("pong"))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	fake := &fakeGateway{
		subscribed: make(chan func(string, any) bool, 1),
		stopped:    make(chan struct{}),
		inbound:    make(chan upstreamFrame, 4),
	}
	tun := New(handler, nil)
	tun.SetGateway(fake)

	client, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("client pc: %v", err)
	}
	defer client.Close()

	dc, err := client.CreateDataChannel(label, nil)
	if err != nil {
		t.Fatalf("data channel: %v", err)
	}
	sess := newSession(dc)
	pushes := make(chan GatewayEvent, 16)
	responses := make(chan wireResponse, 8)
	sess.onMessage = func(data []byte) {
		// One inbound frame is either a gw push or a response — discriminate on "gw".
		var env struct {
			Gw     *GatewayEvent `json:"gw"`
			ID     uint64        `json:"id"`
			Status int           `json:"status"`
			Body   []byte        `json:"body"`
		}
		if json.Unmarshal(data, &env) != nil {
			return
		}
		if env.Gw != nil {
			pushes <- *env.Gw
			return
		}
		responses <- wireResponse{ID: env.ID, Status: env.Status, Body: env.Body}
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

	expectPush := func(want string) GatewayEvent {
		select {
		case ev := <-pushes:
			if ev.T != want {
				t.Fatalf("push: got %q, want %q", ev.T, want)
			}
			return ev
		case <-time.After(8 * time.Second):
			t.Fatalf("no push %q received", want)
			return GatewayEvent{}
		}
	}

	// A bad token must not start a subscription: the Gateway is never invoked.
	badFrame, _ := json.Marshal(wireRequest{
		ID: 0, Method: "GET", Path: gatewayPath,
		Headers: map[string]string{"Authorization": "Bearer nope"},
	})
	if err := sess.send(badFrame); err != nil {
		t.Fatalf("send bad: %v", err)
	}
	select {
	case <-fake.subscribed:
		t.Fatal("invalid token started a subscription")
	case <-time.After(300 * time.Millisecond):
	}

	// A good token opens the subscription; grab the push func to drive events.
	goodFrame, _ := json.Marshal(wireRequest{
		ID: 0, Method: "GET", Path: gatewayPath,
		Headers: map[string]string{"Authorization": "Bearer good"},
	})
	if err := sess.send(goodFrame); err != nil {
		t.Fatalf("send good: %v", err)
	}
	var push func(string, any) bool
	select {
	case push = <-fake.subscribed:
	case <-time.After(8 * time.Second):
		t.Fatal("Gateway.Subscribe never called for a valid token")
	}

	// A client→server upstream frame routes to HandleInbound as the subscribed user.
	if err := sess.send([]byte(`{"up":{"t":"PRESENCE_SET","d":{"state":"idle"}}}`)); err != nil {
		t.Fatalf("send upstream: %v", err)
	}
	select {
	case f := <-fake.inbound:
		if f.T != "PRESENCE_SET" || string(f.D) != `{"state":"idle"}` {
			t.Fatalf("upstream routed wrong: T=%q D=%s", f.T, f.D)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("upstream frame never reached HandleInbound")
	}

	// Pushed events arrive as gw frames, in order, payload intact.
	if !push("MESSAGE_CREATE", map[string]any{"id": 7}) {
		t.Fatal("push returned false on an open channel")
	}
	push("PRESENCE_UPDATE", map[string]any{"user_id": 3})
	ev := expectPush("MESSAGE_CREATE")
	if m, ok := ev.D.(map[string]any); !ok || m["id"] != float64(7) {
		t.Fatalf("push payload not preserved: %#v", ev.D)
	}
	expectPush("PRESENCE_UPDATE")

	// Request/response still multiplexes on the same channel while subscribed.
	reqFrame, _ := json.Marshal(wireRequest{ID: 1, Method: "GET", Path: "/ping"})
	if err := sess.send(reqFrame); err != nil {
		t.Fatalf("send req: %v", err)
	}
	select {
	case r := <-responses:
		if r.ID != 1 || string(r.Body) != "pong" {
			t.Fatalf("response: id=%d body=%q", r.ID, r.Body)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("no response while subscribed")
	}

	// Closing the peer must stop the subscription.
	_ = client.Close()
	select {
	case <-fake.stopped:
	case <-time.After(8 * time.Second):
		t.Fatal("subscription not stopped on peer close")
	}
}
