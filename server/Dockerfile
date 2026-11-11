# syntax=docker/dockerfile:1

FROM rust:1-bookworm AS build
WORKDIR /build/server

COPY server/Cargo.toml server/Cargo.lock server/build.rs ./
COPY server/src/ ./src/
COPY server/prompts/ ./prompts/
COPY skill/proto/ /build/skill/proto/
COPY skill/skills/ /build/skill/skills/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/server/target \
    cargo build --locked --release --bin wien-server \
    && install -m 0755 target/release/wien-server /usr/local/bin/wien-server

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /usr/local/bin/wien-server /usr/local/bin/wien-server
COPY server/config.toml ./config.toml

ENV WIEN_SERVER_HOST=0.0.0.0 \
    WIEN_SERVER_PORT=3001 \
    WIEN_SERVER_CONFIG=/app/config.toml
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl --fail --silent --show-error "http://127.0.0.1:${WIEN_SERVER_PORT}/health" || exit 1

ENTRYPOINT ["wien-server"]
