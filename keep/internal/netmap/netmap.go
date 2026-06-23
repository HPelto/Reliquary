// Package netmap opens the Keep's ports on the local router automatically via
// UPnP-IGD, so most home users don't have to set up port forwarding by hand.
//
// It is strictly a convenience layer on top of the normal "be directly
// reachable" path: a Keep that's already port-forwarded (or on a public IP)
// works exactly as before and ignores this entirely. Discovery and mapping are
// best-effort — if there's no UPnP gateway (disabled, CGNAT, locked-down
// network) it degrades silently to the manual-forwarding instructions, never an
// error that takes the Keep down.
package netmap

import (
	"context"
	"errors"
	"net"
	"sync"
	"time"

	"github.com/huin/goupnp/dcps/internetgateway2"
)

const (
	mapDescription  = "Reliquary Keep"
	leaseSeconds    = 3600             // 1h lease, renewed below — auto-expires if the Keep dies
	renewEvery      = 30 * time.Minute // refresh well before the lease lapses
	discoverTimeout = 6 * time.Second  // SSDP search budget; routers answer in <1s when present
)

// Port is one mapping request: a protocol ("TCP"/"UDP") and the port number,
// mapped 1:1 (external == internal).
type Port struct {
	Proto string
	Num   uint16
}

// Mapping is the per-port result surfaced to the host console.
type Mapping struct {
	Proto string `json:"proto"`
	Port  uint16 `json:"port"`
	OK    bool   `json:"ok"`
	Err   string `json:"err,omitempty"`
}

// Status is a snapshot of the mapper for the host console.
type Status struct {
	Enabled      bool      `json:"enabled"`       // the owner has auto-forwarding turned on
	GatewayFound bool      `json:"gateway_found"` // a UPnP router answered
	Active       bool      `json:"active"`        // at least one port mapped successfully
	ExternalIP   string    `json:"external_ip,omitempty"`
	Mappings     []Mapping `json:"mappings"`
	LastError    string    `json:"last_error,omitempty"`
}

// igdClient is the slice of the goupnp gateway types we use; all three
// connection client types satisfy it.
type igdClient interface {
	AddPortMapping(string, uint16, string, uint16, string, bool, string, uint32) error
	GetExternalIPAddress() (string, error)
	DeletePortMapping(string, uint16, string) error
}

// Manager owns the background discover→map→renew loop and the latest status.
type Manager struct {
	mu     sync.Mutex
	ports  []Port
	status Status
	cancel context.CancelFunc
}

func New() *Manager { return &Manager{} }

// SetPorts records which ports to map. Call before Enable.
func (m *Manager) SetPorts(ports []Port) {
	m.mu.Lock()
	m.ports = append([]Port(nil), ports...)
	m.mu.Unlock()
}

// Enable starts the background mapping+renewal loop. Idempotent — a second call
// while already running is a no-op.
func (m *Manager) Enable() {
	m.mu.Lock()
	if m.cancel != nil {
		m.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.status.Enabled = true
	ports := append([]Port(nil), m.ports...)
	m.mu.Unlock()
	go m.run(ctx, ports)
}

// Disable stops the loop and removes the mappings from the router. Idempotent.
func (m *Manager) Disable() {
	m.mu.Lock()
	cancel := m.cancel
	m.cancel = nil
	m.status = Status{Enabled: false}
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Status returns a copy safe to serialize.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.status
	s.Mappings = append([]Mapping(nil), m.status.Mappings...)
	return s
}

func (m *Manager) run(ctx context.Context, ports []Port) {
	m.attempt(ctx, ports)
	t := time.NewTicker(renewEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			m.teardown(ports)
			return
		case <-t.C:
			m.attempt(ctx, ports)
		}
	}
}

func (m *Manager) attempt(ctx context.Context, ports []Port) {
	client, err := discover(ctx)
	if err != nil {
		m.setError(err.Error())
		return
	}
	internalIP, err := localIP()
	if err != nil {
		m.setError("could not determine this machine's LAN IP: " + err.Error())
		return
	}
	extIP, _ := client.GetExternalIPAddress()

	maps := make([]Mapping, 0, len(ports))
	anyOK := false
	for _, p := range ports {
		mErr := addMapping(client, p, internalIP)
		mp := Mapping{Proto: p.Proto, Port: p.Num, OK: mErr == nil}
		if mErr != nil {
			mp.Err = mErr.Error()
		} else {
			anyOK = true
		}
		maps = append(maps, mp)
	}

	m.mu.Lock()
	m.status.GatewayFound = true
	m.status.Active = anyOK
	m.status.ExternalIP = extIP
	m.status.Mappings = maps
	m.status.LastError = ""
	m.mu.Unlock()
}

// addMapping requests external==internal. Some routers reject a finite lease, so
// fall back to a permanent (0) lease before giving up.
func addMapping(client igdClient, p Port, internalIP string) error {
	err := client.AddPortMapping("", p.Num, p.Proto, p.Num, internalIP, true, mapDescription, leaseSeconds)
	if err != nil {
		err = client.AddPortMapping("", p.Num, p.Proto, p.Num, internalIP, true, mapDescription, 0)
	}
	return err
}

func (m *Manager) teardown(ports []Port) {
	client, err := discover(context.Background())
	if err != nil {
		return
	}
	for _, p := range ports {
		_ = client.DeletePortMapping("", p.Num, p.Proto)
	}
}

func (m *Manager) setError(msg string) {
	m.mu.Lock()
	m.status.GatewayFound = false
	m.status.Active = false
	m.status.Mappings = nil
	m.status.LastError = msg
	m.mu.Unlock()
}

// discover finds the router's WAN connection service, preferring the newer
// IGDv2 IP-connection client and falling back to IGDv1 / PPP.
func discover(ctx context.Context) (igdClient, error) {
	dctx, cancel := context.WithTimeout(ctx, discoverTimeout)
	defer cancel()
	if cs, _, _ := internetgateway2.NewWANIPConnection2ClientsCtx(dctx); len(cs) > 0 {
		return cs[0], nil
	}
	if cs, _, _ := internetgateway2.NewWANIPConnection1ClientsCtx(dctx); len(cs) > 0 {
		return cs[0], nil
	}
	if cs, _, _ := internetgateway2.NewWANPPPConnection1ClientsCtx(dctx); len(cs) > 0 {
		return cs[0], nil
	}
	return nil, errors.New("no UPnP gateway found — turn on UPnP on the router, or forward the port manually")
}

// localIP picks the LAN address the OS would use to reach the internet, which is
// the address the router must forward to. No packets are sent for a UDP dial.
func localIP() (string, error) {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "", err
	}
	defer conn.Close()
	if a, ok := conn.LocalAddr().(*net.UDPAddr); ok {
		return a.IP.String(), nil
	}
	return "", errors.New("unexpected local address type")
}
