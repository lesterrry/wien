# syntax=docker/dockerfile:1
# Keep this version equal to rust-toolchain.toml (checked by scripts/check-workspace.py).
FROM rust:1.98.1-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY server/ ./server/
COPY skill/ ./skill/
COPY crates/ ./crates/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    cargo build --locked --release -p wien-server -p strudel-rag-cli \
    && install -m 0755 target/release/wien-server target/release/strudel-rag /usr/local/bin/

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 wien \
    && useradd --uid 10001 --gid wien --no-create-home wien \
    && install -d -o wien -g wien /var/lib/strudel-rag
WORKDIR /app
USER wien:wien
ENV RUST_LOG=info

FROM runtime AS server
COPY --from=build /usr/local/bin/wien-server /usr/local/bin/wien-server
COPY server/config.toml ./config.toml
ENV WIEN_SERVER_HOST=0.0.0.0 WIEN_SERVER_PORT=3001 WIEN_SERVER_CONFIG=/app/config.toml
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl --fail --silent --show-error "http://127.0.0.1:${WIEN_SERVER_PORT}/health" || exit 1
ENTRYPOINT ["wien-server"]

FROM runtime AS skill
COPY --from=build /usr/local/bin/strudel-rag /usr/local/bin/strudel-rag
COPY skill/config.toml ./config.toml
COPY skill/corpus/sources.toml ./corpus/sources.toml
ENV STRUDEL_RAG_CONFIG=/app/config.toml STRUDEL_RAG_DATA_DIR=/var/lib/strudel-rag STRUDEL_RAG_BIND=0.0.0.0:50051
EXPOSE 50051
# Liveness only; use remote health for readiness.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD ["strudel-rag", "remote", "--endpoint", "http://127.0.0.1:50051", "--timeout-secs", "5", "info"]
ENTRYPOINT ["strudel-rag"]
CMD ["serve"]
