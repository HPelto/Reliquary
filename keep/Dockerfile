FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /keep ./cmd/keep

FROM alpine:3.21
RUN adduser -D -H keep
USER keep
COPY --from=build /keep /usr/local/bin/keep
VOLUME /data
EXPOSE 7777
ENTRYPOINT ["keep", "-addr", ":7777", "-data", "/data/keep.db"]
