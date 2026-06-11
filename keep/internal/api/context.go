package api

import (
	"context"

	"reliquary.gg/keep/internal/store"
)

func withUser(ctx context.Context, u store.User) context.Context {
	return context.WithValue(ctx, userKey, u)
}

func userFrom(ctx context.Context) store.User {
	u, _ := ctx.Value(userKey).(store.User)
	return u
}
