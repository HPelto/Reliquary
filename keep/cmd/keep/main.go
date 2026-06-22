// keep is the Reliquary dedicated server: one binary, one SQLite file,
// your hardware, your rules.
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"flag"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"reliquary.gg/keep/internal/api"
	"reliquary.gg/keep/internal/gateway"
	"reliquary.gg/keep/internal/store"
	"reliquary.gg/keep/internal/voice"
)

// Exit codes a supervising launcher (start-keep.cmd) watches for:
//   42 — rebuild local source and run again (host GUI "Restart")
//   43 — pull latest source first, then rebuild (host GUI "Update & Restart")
const restartExitCode = 42
const updateExitCode = 43

func main() {
	addr := flag.String("addr", ":7777", "listen address")
	data := flag.String("data", "keep.db", "path to the SQLite database file")
	name := flag.String("name", "Reliquary Keep", "instance display name")
	voicePort := flag.Int("voice-port", 7011, "UDP port for voice (SFU); forward this port too")
	voiceIP := flag.String("voice-ip", os.Getenv("VOICE_PUBLIC_IP"), "public IP to advertise for voice (optional; default: gather from interfaces)")
	tlsCert := flag.String("tls-cert", "", "path to a TLS certificate (PEM); serves https/wss when set together with -tls-key")
	tlsKey := flag.String("tls-key", "", "path to the TLS private key (PEM); pairs with -tls-cert")
	flag.Parse()

	st, err := store.Open(*data)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()

	// the host GUI can store a listen address + voice port; explicit flags win
	addrExplicit, voiceExplicit := false, false
	flag.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "addr":
			addrExplicit = true
		case "voice-port":
			voiceExplicit = true
		}
	})
	if stored, _ := st.GetSetting(api.SettingAddr); stored != "" && !addrExplicit {
		*addr = stored
	}
	if stored, _ := st.GetSetting(api.SettingVoicePort); stored != "" && !voiceExplicit {
		if p, perr := strconv.Atoi(stored); perr == nil && p > 0 && p <= 65535 {
			*voicePort = p
		}
	}

	// TLS is optional and off by default. Explicit -tls-cert/-tls-key flags win;
	// otherwise use whatever the host console saved. A cert that won't load never
	// crashes the Keep — we fall back to plain http so the owner can still reach
	// the console and fix it.
	certPath, keyPath := *tlsCert, *tlsKey
	if certPath == "" && keyPath == "" {
		if en, _ := st.GetSetting(api.SettingTLSEnabled); en == "1" {
			certPath, _ = st.GetSetting(api.SettingTLSCertPath)
			keyPath, _ = st.GetSetting(api.SettingTLSKeyPath)
		}
	}
	useTLS := certPath != "" && keyPath != ""
	if useTLS {
		if _, err := tls.LoadX509KeyPair(certPath, keyPath); err != nil {
			log.Printf("  TLS:         could not load cert/key (%v) — falling back to plain http", err)
			useTLS = false
		}
	}
	scheme := "http"
	if useTLS {
		scheme = "https"
	}

	hub := gateway.NewHub(st)
	srv := api.New(st, hub, api.Config{Name: *name})

	// voice SFU: forwards Opus between participants so peers never see each
	// other's IPs. If its UDP port can't bind, the Keep still serves chat.
	if voiceMgr, verr := voice.NewManager(voice.Config{UDPPort: *voicePort, PublicIP: *voiceIP}, hub); verr != nil {
		log.Printf("  voice:       disabled (%v)", verr)
	} else {
		hub.SetInbound(voiceMgr)
		log.Printf("  voice:       SFU on udp/%d", *voicePort)
	}

	count, err := st.CountProfiles()
	if err != nil {
		log.Fatalf("count profiles: %v", err)
	}

	// first boot: mint the admin key for the /admin GUI, print it exactly once
	keyHash, err := st.GetSetting(api.SettingAdminKeyHash)
	if err != nil {
		log.Fatalf("read settings: %v", err)
	}
	log.Printf("◆ %s — %s on %s (data: %s)", *name, api.ProtocolVersion, *addr, *data)
	if keyHash == "" {
		raw := make([]byte, 18)
		if _, err := rand.Read(raw); err != nil {
			log.Fatalf("entropy: %v", err)
		}
		adminKey := hex.EncodeToString(raw)
		if err := st.SetSetting(api.SettingAdminKeyHash, api.HashAdminKey(adminKey)); err != nil {
			log.Fatalf("save admin key: %v", err)
		}
		log.Printf("  admin GUI:   %s://localhost%s/admin", scheme, *addr)
		log.Printf("  admin key:   %s", adminKey)
		log.Printf("  (shown ONCE — save it. it is stored hashed and cannot be re-printed)")
	} else {
		log.Printf("  admin GUI:   %s://localhost%s/admin (key was printed on first boot)", scheme, *addr)
	}
	if useTLS {
		log.Printf("  TLS:         enabled (cert: %s) — clients connect over https/wss", certPath)
	}
	if count == 0 {
		log.Printf("  this keep is unclaimed — the first identity to complete a handshake becomes the owner")
	}

	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Restart support: only when launched by a supervisor that loops on the
	// restart exit codes (start-keep.cmd sets KEEP_SUPERVISED=1). Otherwise the
	// host GUI hides the buttons rather than just killing the server.
	exitWanted := make(chan int, 1)
	if os.Getenv("KEEP_SUPERVISED") == "1" {
		shutdown := func(code int) {
			select {
			case exitWanted <- code:
			default:
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = httpSrv.Shutdown(ctx)
		}
		srv.SetRestart(func() { shutdown(restartExitCode) })
		srv.SetUpdateRestart(func() { shutdown(updateExitCode) })
	}

	if useTLS {
		err = httpSrv.ListenAndServeTLS(certPath, keyPath)
	} else {
		err = httpSrv.ListenAndServe()
	}
	st.Close()
	if err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
	select {
	case code := <-exitWanted:
		if code == updateExitCode {
			log.Printf("pulling latest + rebuilding…")
		} else {
			log.Printf("restarting to apply updates…")
		}
		os.Exit(code)
	default:
	}
}
