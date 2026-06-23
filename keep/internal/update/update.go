// Package update lets a portable Keep binary update itself from GitHub Releases,
// the same way the Electron client uses electron-updater. It reads a small
// manifest published with each release (keep-latest.json), and on demand
// downloads the new portable zip, verifies it against the manifest's SHA-256,
// and swaps keep.exe into place using the Windows rename-while-running trick:
// you can't overwrite a running executable, but you CAN rename it. The
// supervising launcher (start-keep.cmd, or the self-supervisor) then relaunches
// the now-updated binary on the restart exit code.
package update

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Repo is the GitHub owner/name whose Releases the portable Keep updates from.
const Repo = "HPelto/Reliquary"

// These point at the *latest* release's assets via GitHub's stable redirect, so
// we never need the API (no token, no rate limit) to find the newest version.
const (
	manifestURLFmt = "https://github.com/%s/releases/latest/download/keep-latest.json"
	assetURLFmt    = "https://github.com/%s/releases/latest/download/%s"
	defaultAsset   = "Keep-Portable-Windows.zip"
)

var httpClient = &http.Client{Timeout: 60 * time.Second}

// Manifest is the keep-latest.json published alongside each release by
// scripts/build-keep-portable.mjs.
type Manifest struct {
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
	Asset   string `json:"asset"`
}

// Status is the result of a version check.
type Status struct {
	Current string // the running binary's version
	Latest  string // newest version advertised by the release manifest
	Behind  bool   // true when Latest is strictly newer than Current
	Err     string // non-fatal check failure (no network, no manifest, …)
}

// Check fetches the manifest and compares versions. Failures come back in
// Status.Err rather than as a Go error so the host console can show "couldn't
// check" without anything crashing the Keep.
func Check(repo, current string) Status {
	st := Status{Current: current}
	m, err := fetchManifest(repo)
	if err != nil {
		st.Err = err.Error()
		return st
	}
	st.Latest = m.Version
	// Only a real stamped release can be "behind". An unstamped build ("dev",
	// empty, or 0.0.0 — e.g. a hand `go build`) never offers an update.
	st.Behind = isRelease(current) && newer(m.Version, current)
	return st
}

// isRelease reports whether v looks like a stamped release version (has a
// non-zero numeric component), as opposed to "dev"/""/"0.0.0".
func isRelease(v string) bool {
	for _, n := range parseVer(v) {
		if n > 0 {
			return true
		}
	}
	return false
}

// Apply downloads the latest portable zip, verifies its SHA-256 against the
// manifest, extracts the new keep.exe beside the running one, and swaps it into
// place. On success the caller must exit with the supervisor's restart code so
// the launcher relaunches the updated binary.
func Apply(repo string) error {
	m, err := fetchManifest(repo)
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate self: %w", err)
	}
	exe, _ = filepath.Abs(exe)

	zipBytes, err := download(fmt.Sprintf(assetURLFmt, repo, m.Asset))
	if err != nil {
		return err
	}
	sum := sha256.Sum256(zipBytes)
	if got := hex.EncodeToString(sum[:]); !strings.EqualFold(got, m.SHA256) {
		return fmt.Errorf("checksum mismatch (expected %s, got %s) — refusing to install", m.SHA256, got)
	}

	newBin, err := extractExe(zipBytes, filepath.Base(exe))
	if err != nil {
		return err
	}
	staged := exe + ".new"
	if err := os.WriteFile(staged, newBin, 0o755); err != nil {
		return fmt.Errorf("stage new binary: %w", err)
	}
	if err := swap(exe, staged); err != nil {
		os.Remove(staged)
		return err
	}
	return nil
}

// CleanupOld removes the leftovers from a prior update (the displaced old binary
// and any half-staged new one). Call once on boot.
func CleanupOld() {
	if exe, err := os.Executable(); err == nil {
		exe, _ = filepath.Abs(exe)
		_ = os.Remove(exe + ".old")
		_ = os.Remove(exe + ".new")
	}
}

func fetchManifest(repo string) (Manifest, error) {
	var m Manifest
	resp, err := httpClient.Get(fmt.Sprintf(manifestURLFmt, repo))
	if err != nil {
		return m, fmt.Errorf("reach GitHub: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return m, fmt.Errorf("no release manifest (HTTP %d)", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(body, &m); err != nil {
		return m, fmt.Errorf("bad manifest: %w", err)
	}
	if m.Version == "" || m.SHA256 == "" {
		return m, fmt.Errorf("incomplete manifest")
	}
	if m.Asset == "" {
		m.Asset = defaultAsset
	}
	return m, nil
}

func download(url string) ([]byte, error) {
	resp, err := httpClient.Get(url)
	if err != nil {
		return nil, fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download failed (HTTP %d)", resp.StatusCode)
	}
	// portable zip is ~16 MB; cap at 256 MB as a sanity bound
	return io.ReadAll(io.LimitReader(resp.Body, 256*1024*1024))
}

func extractExe(zipBytes []byte, name string) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		return nil, fmt.Errorf("open release zip: %w", err)
	}
	for _, f := range zr.File {
		if strings.EqualFold(filepath.Base(f.Name), name) {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			return io.ReadAll(rc)
		}
	}
	return nil, fmt.Errorf("%s not found in release zip", name)
}

// swap replaces the running exe with the staged one. Windows refuses to
// overwrite a binary that's running, but it allows renaming one — so we move the
// current binary aside (.old) and move the staged one into its place. The .old
// file is removed on the next boot by CleanupOld.
func swap(exe, staged string) error {
	old := exe + ".old"
	_ = os.Remove(old) // best effort; may be locked if a prior supervisor still holds it
	if err := os.Rename(exe, old); err != nil {
		return fmt.Errorf("move current binary aside: %w", err)
	}
	if err := os.Rename(staged, exe); err != nil {
		_ = os.Rename(old, exe) // restore so the Keep is never left without a binary
		return fmt.Errorf("install new binary: %w", err)
	}
	return nil
}

// newer reports whether version a is strictly newer than b, comparing dotted
// numeric components (so 0.1.10 > 0.1.9). A leading "v" is ignored, and any
// unparseable component counts as 0 — a malformed version never reads as newer.
func newer(a, b string) bool {
	pa, pb := parseVer(a), parseVer(b)
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func parseVer(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	parts := strings.Split(v, ".")
	out := make([]int, len(parts))
	for i, p := range parts {
		out[i], _ = strconv.Atoi(strings.TrimSpace(p))
	}
	return out
}
