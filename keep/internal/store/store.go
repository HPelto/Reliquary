// Package store is the Keep's persistence layer: a single SQLite file,
// pure-Go driver, no external services.
//
// Identity model: accounts are client-owned. A profile is keyed by the
// client's Ed25519 public key; the Keep never sees a password or email.
// The profile row is generated from what the client presents during the
// handshake (display name, accent) and lives only in this Keep's file.
package store

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound  = errors.New("not found")
	ErrBadInvite = errors.New("invite is invalid, expired, or used up")
)

type User struct {
	ID          int64  `json:"id"`
	Pubkey      string `json:"pubkey"` // base64 Ed25519 public key
	Fingerprint string `json:"fingerprint"`
	Username    string `json:"username"` // display name, chosen by the client
	Accent      string `json:"accent"`   // hex color, chosen by the client
	Role        string `json:"role"`
	About       string `json:"about"`       // free-text bio
	Status      string `json:"status"`      // short status line
	Avatar      string `json:"avatar"`      // media hash, or "" for the generated default
	Background  string `json:"background"`  // media hash for the profile banner
	NameFont    string `json:"name_font"`   // username display font key
	NameEffect  string `json:"name_effect"` // username effect key (neon, glitch, …)
	NameColor   string `json:"name_color"`  // username text color, or "" for default
}

// Profile carries the client-supplied fields of an identity. The keypair
// fields (pubkey/fingerprint/role) are the Keep's business, not the client's.
type Profile struct {
	Username   string
	Accent     string
	About      string
	Status     string
	Avatar     string
	Background string
	NameFont   string
	NameEffect string
	NameColor  string
}

// FingerprintOf renders a short human-readable digest of a public key,
// e.g. "9f2a-77c1-04bd-e3a8".
func FingerprintOf(pubkeyRaw []byte) string {
	sum := sha256.Sum256(pubkeyRaw)
	h := hex.EncodeToString(sum[:8])
	return fmt.Sprintf("%s-%s-%s-%s", h[0:4], h[4:8], h[8:12], h[12:16])
}

type Channel struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Kind     string `json:"kind"` // "text" | "voice"
	Position int    `json:"position"`
}

// Attachment is an image (or other media) carried by a message. The bytes live
// in the content-addressed media table; this is the per-message metadata the
// client supplies on send (it knows the dimensions after decoding the image).
type Attachment struct {
	Hash        string `json:"hash"`
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	Size        int64  `json:"size"`
}

// ReplyPreview is the lightweight snapshot of the message a reply points at, so
// the client can render the quoted line without a second fetch. Nil when the
// original was deleted.
type ReplyPreview struct {
	ID             int64  `json:"id"`
	AuthorID       int64  `json:"author_id"`
	AuthorUsername string `json:"author_username"`
	Content        string `json:"content"`
	HasAttachments bool   `json:"has_attachments"`
}

type Message struct {
	ID          int64         `json:"id"`
	ChannelID   int64         `json:"channel_id"`
	Author      User          `json:"author"`
	Content     string        `json:"content"`
	Attachments []Attachment  `json:"attachments"`
	ReplyTo     int64         `json:"reply_to"`               // referenced message id, 0 = not a reply
	ReplyPreview *ReplyPreview `json:"reply_preview,omitempty"` // resolved snapshot, nil if original gone
	Pinned      bool          `json:"pinned"`
	CreatedAt   int64         `json:"created_at"` // unix ms
	EditedAt    int64         `json:"edited_at"`  // unix ms, 0 = never edited
}

type Invite struct {
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expires_at"` // unix ms, 0 = never
	MaxUses   int    `json:"max_uses"`   // 0 = unlimited
	Uses      int    `json:"uses"`
}

type Event struct {
	ID           int64  `json:"id"`
	Title        string `json:"title"`
	Description  string `json:"description"`
	LocationKind string `json:"location_kind"` // "voice" | "other"
	ChannelID    int64  `json:"channel_id"`    // 0 when location_kind != voice
	LocationText string `json:"location_text"` // free text / link for "other"
	Cover        string `json:"cover"`         // media hash, or ""
	StartsAt     int64  `json:"starts_at"`     // unix ms
	EndsAt       int64  `json:"ends_at"`       // unix ms, 0 = open-ended
	Frequency    string `json:"frequency"`     // "once" | "daily" | "weekly" | "monthly"
	CreatedBy    int64  `json:"created_by"`
	CreatedAt    int64  `json:"created_at"`
}

type Store struct {
	db       *sql.DB
	mediaDir string
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// modernc.org/sqlite is happiest with a single writer connection.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`); err != nil {
		return nil, err
	}
	// media bytes live on disk next to the DB so large files stream (Range) from
	// the OS instead of loading the whole blob into memory per request.
	mediaDir := filepath.Join(filepath.Dir(path), "media")
	if err := os.MkdirAll(mediaDir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{db: db, mediaDir: mediaDir}
	if err := s.migrate(); err != nil {
		return nil, err
	}
	s.migrateMediaToDisk() // best-effort: move legacy blob media to disk files
	return s, nil
}

// migrateMediaToDisk moves any media still stored as a SQLite blob onto disk
// (one-time) so it streams like new uploads, then empties the blob to reclaim
// space. Best-effort — failures for a single item are skipped, never fatal.
func (s *Store) migrateMediaToDisk() {
	rows, err := s.db.Query(`SELECT hash FROM media WHERE length(bytes) > 0`)
	if err != nil {
		return
	}
	var hashes []string
	for rows.Next() {
		var h string
		if rows.Scan(&h) == nil {
			hashes = append(hashes, h)
		}
	}
	rows.Close() // close before per-item queries — modernc sqlite is single-conn

	for _, h := range hashes {
		dst := filepath.Join(s.mediaDir, h)
		if _, statErr := os.Stat(dst); statErr == nil {
			s.db.Exec(`UPDATE media SET bytes = ? WHERE hash = ?`, []byte{}, h) // already on disk
			continue
		}
		var data []byte
		if s.db.QueryRow(`SELECT bytes FROM media WHERE hash = ?`, h).Scan(&data) != nil || len(data) == 0 {
			continue
		}
		tmp := dst + ".tmp"
		if os.WriteFile(tmp, data, 0o644) != nil {
			continue
		}
		if os.Rename(tmp, dst) != nil {
			os.Remove(tmp)
			continue
		}
		s.db.Exec(`UPDATE media SET bytes = ? WHERE hash = ?`, []byte{}, h)
	}
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pubkey TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  username TEXT NOT NULL,
  accent TEXT NOT NULL DEFAULT '#8b7cf6',
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  creator_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media (
  hash TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location_kind TEXT NOT NULL DEFAULT 'other',
  channel_id INTEGER NOT NULL DEFAULT 0,
  location_text TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL DEFAULT 0,
  frequency TEXT NOT NULL DEFAULT 'once',
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);`)
	if err != nil {
		return err
	}

	// profile columns added after the first release — backfill on old DBs
	for _, col := range []struct{ name, ddl string }{
		{"about", "about TEXT NOT NULL DEFAULT ''"},
		{"status", "status TEXT NOT NULL DEFAULT ''"},
		{"avatar", "avatar TEXT NOT NULL DEFAULT ''"},
		{"background", "background TEXT NOT NULL DEFAULT ''"},
		{"name_font", "name_font TEXT NOT NULL DEFAULT ''"},
		{"name_effect", "name_effect TEXT NOT NULL DEFAULT ''"},
		{"name_color", "name_color TEXT NOT NULL DEFAULT ''"},
	} {
		if !s.columnExists("profiles", col.name) {
			if _, err := s.db.Exec(`ALTER TABLE profiles ADD COLUMN ` + col.ddl); err != nil {
				return err
			}
		}
	}

	// events.ends_at added after the events table shipped
	if !s.columnExists("events", "ends_at") {
		if _, err := s.db.Exec(`ALTER TABLE events ADD COLUMN ends_at INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
	}

	// message attachments + edit timestamp added after messaging shipped;
	// reply_to + pinned added alongside replies/pins
	for _, col := range []struct{ name, ddl string }{
		{"attachments", "attachments TEXT NOT NULL DEFAULT '[]'"},
		{"edited_at", "edited_at INTEGER NOT NULL DEFAULT 0"},
		{"reply_to", "reply_to INTEGER NOT NULL DEFAULT 0"},
		{"pinned", "pinned INTEGER NOT NULL DEFAULT 0"},
	} {
		if !s.columnExists("messages", col.name) {
			if _, err := s.db.Exec(`ALTER TABLE messages ADD COLUMN ` + col.ddl); err != nil {
				return err
			}
		}
	}

	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM channels`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		_, err = s.db.Exec(`INSERT INTO channels (name, kind, position) VALUES
			('tavern', 'text', 0), ('clips-and-media', 'text', 1), ('war-room', 'voice', 2)`)
	}
	return err
}

func (s *Store) columnExists(table, column string) bool {
	rows, err := s.db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if rows.Scan(&name) == nil && name == column {
			return true
		}
	}
	return false
}

func nowMS() int64 { return time.Now().UnixMilli() }

// ── media (avatars, backgrounds) ────────────────────────────────────

// PutMedia stores content-addressed bytes on disk (content-addressed → a repeat
// upload is a no-op) and records metadata in the DB. The bytes column is left
// empty for these disk-backed entries; they're served from the file.
func (s *Store) PutMedia(hash, contentType string, data []byte) error {
	dst := filepath.Join(s.mediaDir, hash)
	if _, statErr := os.Stat(dst); statErr != nil {
		tmp := dst + ".tmp"
		if err := os.WriteFile(tmp, data, 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, dst); err != nil {
			os.Remove(tmp)
			return err
		}
	}
	_, err := s.db.Exec(
		`INSERT INTO media (hash, content_type, size, bytes, created_at)
		 VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING`,
		hash, contentType, len(data), []byte{}, nowMS(),
	)
	return err
}

func (s *Store) MediaExists(hash string) (bool, error) {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM media WHERE hash = ?`, hash).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// MediaFilePath is where a disk-backed media blob lives (may not exist for media
// uploaded before disk storage — those fall back to GetMedia).
func (s *Store) MediaFilePath(hash string) string {
	return filepath.Join(s.mediaDir, hash)
}

// MediaContentType returns just the stored MIME type. ErrNotFound if unknown.
func (s *Store) MediaContentType(hash string) (string, error) {
	var ct string
	err := s.db.QueryRow(`SELECT content_type FROM media WHERE hash = ?`, hash).Scan(&ct)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return ct, err
}

// GetMedia returns the bytes for older blob-backed media (pre-disk storage).
func (s *Store) GetMedia(hash string) (contentType string, data []byte, err error) {
	err = s.db.QueryRow(`SELECT content_type, bytes FROM media WHERE hash = ?`, hash).
		Scan(&contentType, &data)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, ErrNotFound
	}
	return contentType, data, err
}

// ── settings ────────────────────────────────────────────────────────

func (s *Store) GetSetting(key string) (string, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

func (s *Store) SetSetting(key, value string) error {
	_, err := s.db.Exec(
		`INSERT INTO settings (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// ── profiles & sessions ─────────────────────────────────────────────

func (s *Store) CountProfiles() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM profiles`).Scan(&n)
	return n, err
}

const userCols = `id, pubkey, fingerprint, username, accent, role, about, status, avatar, background, name_font, name_effect, name_color`

func scanUser(row interface{ Scan(...any) error }) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Pubkey, &u.Fingerprint, &u.Username, &u.Accent, &u.Role,
		&u.About, &u.Status, &u.Avatar, &u.Background, &u.NameFont, &u.NameEffect, &u.NameColor)
	return u, err
}

// CreateProfile generates this Keep's local record for a client identity.
func (s *Store) CreateProfile(pubkey string, pubkeyRaw []byte, role string, p Profile) (User, error) {
	fp := FingerprintOf(pubkeyRaw)
	res, err := s.db.Exec(
		`INSERT INTO profiles (pubkey, fingerprint, username, accent, role, about, status, avatar, background, name_font, name_effect, name_color, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		pubkey, fp, p.Username, p.Accent, role, p.About, p.Status, p.Avatar, p.Background, p.NameFont, p.NameEffect, p.NameColor, nowMS(),
	)
	if err != nil {
		return User{}, err
	}
	id, _ := res.LastInsertId()
	return User{
		ID: id, Pubkey: pubkey, Fingerprint: fp, Role: role,
		Username: p.Username, Accent: p.Accent, About: p.About,
		Status: p.Status, Avatar: p.Avatar, Background: p.Background,
		NameFont: p.NameFont, NameEffect: p.NameEffect, NameColor: p.NameColor,
	}, nil
}

func (s *Store) ProfileByPubkey(pubkey string) (User, error) {
	u, err := scanUser(s.db.QueryRow(
		`SELECT `+userCols+` FROM profiles WHERE pubkey = ?`, pubkey))
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

// UpdateProfile refreshes all client-supplied fields on a returning identity.
func (s *Store) UpdateProfile(id int64, p Profile) (User, error) {
	_, err := s.db.Exec(
		`UPDATE profiles SET username = ?, accent = ?, about = ?, status = ?, avatar = ?, background = ?,
		 name_font = ?, name_effect = ?, name_color = ? WHERE id = ?`,
		p.Username, p.Accent, p.About, p.Status, p.Avatar, p.Background, p.NameFont, p.NameEffect, p.NameColor, id,
	)
	if err != nil {
		return User{}, err
	}
	return scanUser(s.db.QueryRow(`SELECT `+userCols+` FROM profiles WHERE id = ?`, id))
}

// SetRole assigns member | admin | owner. Validation is the caller's job.
func (s *Store) SetRole(id int64, role string) (User, error) {
	res, err := s.db.Exec(`UPDATE profiles SET role = ? WHERE id = ?`, role, id)
	if err != nil {
		return User{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return User{}, ErrNotFound
	}
	return scanUser(s.db.QueryRow(`SELECT `+userCols+` FROM profiles WHERE id = ?`, id))
}

// DeleteProfile removes a user; sessions and messages cascade away with it.
func (s *Store) DeleteProfile(id int64) error {
	res, err := s.db.Exec(`DELETE FROM profiles WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *Store) CreateSession(profileID int64) (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := hex.EncodeToString(raw)
	_, err := s.db.Exec(
		`INSERT INTO sessions (token_hash, profile_id, created_at) VALUES (?, ?, ?)`,
		hashToken(token), profileID, nowMS(),
	)
	return token, err
}

func (s *Store) UserByToken(token string) (User, error) {
	u, err := scanUser(s.db.QueryRow(
		`SELECT u.id, u.pubkey, u.fingerprint, u.username, u.accent, u.role,
		        u.about, u.status, u.avatar, u.background, u.name_font, u.name_effect, u.name_color
		 FROM sessions s JOIN profiles u ON u.id = s.profile_id
		 WHERE s.token_hash = ?`, hashToken(token)))
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

func (s *Store) Members() ([]User, error) {
	rows, err := s.db.Query(`SELECT ` + userCols + ` FROM profiles ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// ── channels & messages ─────────────────────────────────────────────

func (s *Store) Channels() ([]Channel, error) {
	rows, err := s.db.Query(`SELECT id, name, kind, position FROM channels ORDER BY position, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Channel
	for rows.Next() {
		var c Channel
		if err := rows.Scan(&c.ID, &c.Name, &c.Kind, &c.Position); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) CreateChannel(name, kind string) (Channel, error) {
	var maxPos sql.NullInt64
	if err := s.db.QueryRow(`SELECT MAX(position) FROM channels`).Scan(&maxPos); err != nil {
		return Channel{}, err
	}
	pos := int(maxPos.Int64) + 1
	res, err := s.db.Exec(
		`INSERT INTO channels (name, kind, position) VALUES (?, ?, ?)`, name, kind, pos)
	if err != nil {
		return Channel{}, err
	}
	id, _ := res.LastInsertId()
	return Channel{ID: id, Name: name, Kind: kind, Position: pos}, nil
}

func (s *Store) RenameChannel(id int64, name string) error {
	res, err := s.db.Exec(`UPDATE channels SET name = ? WHERE id = ?`, name, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteChannel(id int64) error {
	res, err := s.db.Exec(`DELETE FROM channels WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ChannelByID(id int64) (Channel, error) {
	var c Channel
	err := s.db.QueryRow(`SELECT id, name, kind, position FROM channels WHERE id = ?`, id).
		Scan(&c.ID, &c.Name, &c.Kind, &c.Position)
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	return c, err
}

func (s *Store) CreateMessage(channelID, authorID int64, content string, attachments []Attachment, replyTo int64) (Message, error) {
	author, err := scanUser(s.db.QueryRow(
		`SELECT `+userCols+` FROM profiles WHERE id = ?`, authorID))
	if err != nil {
		return Message{}, err
	}
	if attachments == nil {
		attachments = []Attachment{}
	}
	attachJSON, _ := json.Marshal(attachments)
	created := nowMS()
	res, err := s.db.Exec(
		`INSERT INTO messages (channel_id, author_id, content, attachments, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		channelID, authorID, content, string(attachJSON), replyTo, created,
	)
	if err != nil {
		return Message{}, err
	}
	id, _ := res.LastInsertId()
	m := Message{ID: id, ChannelID: channelID, Author: author, Content: content, Attachments: attachments, ReplyTo: replyTo, CreatedAt: created}
	s.resolveReply(&m)
	return m, nil
}

// shared message SELECT — keep Messages() and MessageByID() in lockstep.
const msgCols = `m.id, m.channel_id, m.content, m.attachments, m.reply_to, m.pinned, m.created_at, m.edited_at,
	             u.id, u.pubkey, u.fingerprint, u.username, u.accent, u.role,
	             u.about, u.status, u.avatar, u.background, u.name_font, u.name_effect, u.name_color`

type rowScanner interface {
	Scan(dest ...any) error
}

func scanMessage(sc rowScanner) (Message, error) {
	var m Message
	var attachJSON string
	var pinned int
	if err := sc.Scan(&m.ID, &m.ChannelID, &m.Content, &attachJSON, &m.ReplyTo, &pinned, &m.CreatedAt, &m.EditedAt,
		&m.Author.ID, &m.Author.Pubkey, &m.Author.Fingerprint,
		&m.Author.Username, &m.Author.Accent, &m.Author.Role,
		&m.Author.About, &m.Author.Status, &m.Author.Avatar, &m.Author.Background,
		&m.Author.NameFont, &m.Author.NameEffect, &m.Author.NameColor); err != nil {
		return Message{}, err
	}
	m.Pinned = pinned != 0
	if attachJSON != "" {
		_ = json.Unmarshal([]byte(attachJSON), &m.Attachments)
	}
	if m.Attachments == nil {
		m.Attachments = []Attachment{}
	}
	return m, nil
}

// resolveReply fills m.ReplyPreview from m.ReplyTo. Left nil if the original was
// deleted, so the client can show "original message deleted".
func (s *Store) resolveReply(m *Message) {
	if m.ReplyTo == 0 {
		return
	}
	var p ReplyPreview
	var attachJSON string
	err := s.db.QueryRow(
		`SELECT m.id, m.content, m.attachments, u.id, u.username
		 FROM messages m JOIN profiles u ON u.id = m.author_id WHERE m.id = ?`, m.ReplyTo).
		Scan(&p.ID, &p.Content, &attachJSON, &p.AuthorID, &p.AuthorUsername)
	if err != nil {
		return
	}
	if r := []rune(p.Content); len(r) > 120 {
		p.Content = string(r[:120]) + "…"
	}
	p.HasAttachments = attachJSON != "" && attachJSON != "[]"
	m.ReplyPreview = &p
}

// MessageByID fetches one message (used to authorize edit/delete and to return
// the post-edit state). Returns ErrNotFound if it doesn't exist.
func (s *Store) MessageByID(id int64) (Message, error) {
	m, err := scanMessage(s.db.QueryRow(
		`SELECT `+msgCols+` FROM messages m JOIN profiles u ON u.id = m.author_id WHERE m.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, ErrNotFound
	}
	if err != nil {
		return Message{}, err
	}
	s.resolveReply(&m)
	return m, nil
}

// SetPinned toggles a message's pinned flag and returns the updated message.
func (s *Store) SetPinned(id int64, pinned bool) (Message, error) {
	v := 0
	if pinned {
		v = 1
	}
	res, err := s.db.Exec(`UPDATE messages SET pinned = ? WHERE id = ?`, v, id)
	if err != nil {
		return Message{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Message{}, ErrNotFound
	}
	return s.MessageByID(id)
}

// PinnedMessages lists a channel's pinned messages, most recently posted first.
func (s *Store) PinnedMessages(channelID int64) ([]Message, error) {
	rows, err := s.db.Query(
		`SELECT `+msgCols+` FROM messages m JOIN profiles u ON u.id = m.author_id
		 WHERE m.channel_id = ? AND m.pinned = 1 ORDER BY m.id DESC`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		s.resolveReply(&out[i]) // after draining — single SQLite connection
	}
	return out, nil
}

// UpdateMessage edits content (author-only — author_id is part of the WHERE so
// a non-author update affects no rows and returns ErrNotFound). Stamps edited_at.
func (s *Store) UpdateMessage(id, authorID int64, content string) (Message, error) {
	res, err := s.db.Exec(
		`UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND author_id = ?`,
		content, nowMS(), id, authorID)
	if err != nil {
		return Message{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Message{}, ErrNotFound
	}
	return s.MessageByID(id)
}

// DeleteMessage removes a message. Authorization (author or admin/owner) is the
// caller's job — verify via MessageByID first.
func (s *Store) DeleteMessage(id int64) error {
	res, err := s.db.Exec(`DELETE FROM messages WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// Messages returns up to limit messages in a channel, oldest first, optionally
// only those with id < before (for backwards pagination).
func (s *Store) Messages(channelID int64, limit int, before int64) ([]Message, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	q := `SELECT ` + msgCols + `
	      FROM messages m JOIN profiles u ON u.id = m.author_id
	      WHERE m.channel_id = ?`
	args := []any{channelID}
	if before > 0 {
		q += ` AND m.id < ?`
		args = append(args, before)
	}
	q += fmt.Sprintf(` ORDER BY m.id DESC LIMIT %d`, limit)

	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// resolve replies only after the result set is drained — SQLite runs on a
	// single connection, so a nested query while `rows` is open would deadlock.
	for i := range out {
		s.resolveReply(&out[i])
	}
	// reverse to oldest-first
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

// ── invites ─────────────────────────────────────────────────────────

const inviteAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func (s *Store) CreateInvite(creatorID int64, ttl time.Duration, maxUses int) (Invite, error) {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return Invite{}, err
	}
	token := make([]byte, 8)
	for i, b := range raw {
		token[i] = inviteAlphabet[int(b)%len(inviteAlphabet)]
	}
	var expires int64
	if ttl > 0 {
		expires = time.Now().Add(ttl).UnixMilli()
	}
	inv := Invite{Token: string(token), ExpiresAt: expires, MaxUses: maxUses}
	_, err := s.db.Exec(
		`INSERT INTO invites (token, creator_id, expires_at, max_uses, uses, created_at)
		 VALUES (?, ?, ?, ?, 0, ?)`,
		inv.Token, creatorID, expires, maxUses, nowMS(),
	)
	return inv, err
}

func (s *Store) Invites() ([]Invite, error) {
	rows, err := s.db.Query(
		`SELECT token, expires_at, max_uses, uses FROM invites ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Invite
	for rows.Next() {
		var inv Invite
		if err := rows.Scan(&inv.Token, &inv.ExpiresAt, &inv.MaxUses, &inv.Uses); err != nil {
			return nil, err
		}
		out = append(out, inv)
	}
	return out, rows.Err()
}

func (s *Store) DeleteInvite(token string) error {
	res, err := s.db.Exec(`DELETE FROM invites WHERE token = ?`, token)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) InviteByToken(token string) (Invite, error) {
	var inv Invite
	err := s.db.QueryRow(
		`SELECT token, expires_at, max_uses, uses FROM invites WHERE token = ?`, token,
	).Scan(&inv.Token, &inv.ExpiresAt, &inv.MaxUses, &inv.Uses)
	if errors.Is(err, sql.ErrNoRows) {
		return Invite{}, ErrNotFound
	}
	return inv, err
}

func (inv Invite) Valid() bool {
	if inv.ExpiresAt > 0 && nowMS() > inv.ExpiresAt {
		return false
	}
	if inv.MaxUses > 0 && inv.Uses >= inv.MaxUses {
		return false
	}
	return true
}

// RedeemInvite atomically validates and consumes one use of an invite.
func (s *Store) RedeemInvite(token string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var inv Invite
	err = tx.QueryRow(
		`SELECT token, expires_at, max_uses, uses FROM invites WHERE token = ?`, token,
	).Scan(&inv.Token, &inv.ExpiresAt, &inv.MaxUses, &inv.Uses)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrBadInvite
	}
	if err != nil {
		return err
	}
	if !inv.Valid() {
		return ErrBadInvite
	}
	if _, err := tx.Exec(`UPDATE invites SET uses = uses + 1 WHERE token = ?`, token); err != nil {
		return err
	}
	return tx.Commit()
}

// ── events ──────────────────────────────────────────────────────────

const eventCols = `id, title, description, location_kind, channel_id, location_text, cover, starts_at, ends_at, frequency, created_by, created_at`

func scanEvent(row interface{ Scan(...any) error }) (Event, error) {
	var e Event
	err := row.Scan(&e.ID, &e.Title, &e.Description, &e.LocationKind, &e.ChannelID,
		&e.LocationText, &e.Cover, &e.StartsAt, &e.EndsAt, &e.Frequency, &e.CreatedBy, &e.CreatedAt)
	return e, err
}

func (s *Store) CreateEvent(creatorID int64, e Event) (Event, error) {
	created := nowMS()
	res, err := s.db.Exec(
		`INSERT INTO events (title, description, location_kind, channel_id, location_text, cover, starts_at, ends_at, frequency, created_by, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.Title, e.Description, e.LocationKind, e.ChannelID, e.LocationText, e.Cover,
		e.StartsAt, e.EndsAt, e.Frequency, creatorID, created,
	)
	if err != nil {
		return Event{}, err
	}
	id, _ := res.LastInsertId()
	e.ID = id
	e.CreatedBy = creatorID
	e.CreatedAt = created
	return e, nil
}

// Events returns events ordered by start time (soonest first).
func (s *Store) Events() ([]Event, error) {
	rows, err := s.db.Query(`SELECT ` + eventCols + ` FROM events ORDER BY starts_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) DeleteEvent(id int64) error {
	res, err := s.db.Exec(`DELETE FROM events WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
