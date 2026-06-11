package api

// Scheduled events. Owners/admins create and delete; all members can list.
// Cover images reuse the content-addressed media endpoints.

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"reliquary.gg/keep/internal/store"
)

var validFrequency = map[string]bool{"once": true, "daily": true, "weekly": true, "monthly": true}

func (s *Server) handleListEvents(w http.ResponseWriter, r *http.Request) {
	events, err := s.st.Events()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

type createEventReq struct {
	Title        string `json:"title"`
	Description  string `json:"description"`
	LocationKind string `json:"location_kind"`
	ChannelID    int64  `json:"channel_id"`
	LocationText string `json:"location_text"`
	Cover        string `json:"cover"`
	StartsAt     int64  `json:"starts_at"`
	EndsAt       int64  `json:"ends_at"`
	Frequency    string `json:"frequency"`
}

func (s *Server) handleCreateEvent(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r.Context())
	if user.Role != "owner" && user.Role != "admin" {
		writeError(w, http.StatusForbidden, "only owners and admins can create events")
		return
	}
	var req createEventReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}

	req.Title = strings.TrimSpace(req.Title)
	if len(req.Title) < 1 || len(req.Title) > 100 {
		writeError(w, http.StatusBadRequest, "title must be 1-100 characters")
		return
	}
	if len(req.Description) > 1000 {
		writeError(w, http.StatusBadRequest, "description must be 1000 characters or fewer")
		return
	}
	if req.StartsAt <= 0 {
		writeError(w, http.StatusBadRequest, "starts_at is required")
		return
	}
	if req.EndsAt != 0 && req.EndsAt <= req.StartsAt {
		writeError(w, http.StatusBadRequest, "the event must end after it starts")
		return
	}
	if req.Frequency == "" {
		req.Frequency = "once"
	}
	if !validFrequency[req.Frequency] {
		writeError(w, http.StatusBadRequest, "invalid frequency")
		return
	}
	if len(req.Cover) > 80 {
		writeError(w, http.StatusBadRequest, "cover reference too long")
		return
	}

	ev := store.Event{
		Title:       req.Title,
		Description: strings.TrimSpace(req.Description),
		Cover:       req.Cover,
		StartsAt:    req.StartsAt,
		EndsAt:      req.EndsAt,
		Frequency:   req.Frequency,
	}

	switch req.LocationKind {
	case "voice":
		ch, err := s.st.ChannelByID(req.ChannelID)
		if errors.Is(err, store.ErrNotFound) || (err == nil && ch.Kind != "voice") {
			writeError(w, http.StatusBadRequest, "channel_id must reference a voice channel on this keep")
			return
		}
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusInternalServerError, "storage error")
			return
		}
		ev.LocationKind = "voice"
		ev.ChannelID = ch.ID
	default:
		text := strings.TrimSpace(req.LocationText)
		if len(text) > 200 {
			writeError(w, http.StatusBadRequest, "location must be 200 characters or fewer")
			return
		}
		ev.LocationKind = "other"
		ev.LocationText = text
	}

	created, err := s.st.CreateEvent(user.ID, ev)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	s.hub.Broadcast("EVENT_CREATE", created)
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleDeleteEvent(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r.Context())
	if user.Role != "owner" && user.Role != "admin" {
		writeError(w, http.StatusForbidden, "only owners and admins can delete events")
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad event id")
		return
	}
	if err := s.st.DeleteEvent(id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "no such event")
			return
		}
		writeError(w, http.StatusInternalServerError, "storage error")
		return
	}
	s.hub.Broadcast("EVENT_DELETE", map[string]any{"id": id})
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}
