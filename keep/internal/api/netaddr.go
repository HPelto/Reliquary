package api

import (
	"net"
	"net/http"
	"strconv"
)

// handleNetAddresses returns this host's private LAN IPv4 addresses so the
// owner's client can mint invites that are actually reachable from other
// machines on the network. Without this, a Keep run locally and joined over
// loopback would bake "localhost" into every invite — useless to a peer. The
// port is taken from the address the request arrived on (what the owner dialed).
func (s *Server) handleNetAddresses(w http.ResponseWriter, r *http.Request) {
	port := 7777
	if _, p, err := net.SplitHostPort(r.Host); err == nil {
		if n, convErr := strconv.Atoi(p); convErr == nil && n > 0 {
			port = n
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"candidates": privateIPv4s(),
		"port":       port,
	})
}

// privateIPv4s lists the host's RFC1918 IPv4 addresses (10/8, 172.16/12,
// 192.168/16), skipping loopback and link-local — the addresses a LAN peer can
// actually dial.
func privateIPv4s() []string {
	out := []string{}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return out
	}
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipnet.IP.To4()
		if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
			continue
		}
		if ip.IsPrivate() {
			out = append(out, ip.String())
		}
	}
	return out
}
