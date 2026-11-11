# syntax=docker/dockerfile:1

FROM rust:1-bookworm AS build
WORKDIR /build

COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
COPY proto/ ./proto/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    cargo build --locked --release -p strudel-rag-cli \
    && install -m 0755 target/release/strudel-rag /usr/local/bin/strudel-rag

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 strudel-rag \
    && useradd --uid 10001 --gid strudel-rag --no-create-home strudel-rag \
    && install -d -o strudel-rag -g strudel-rag /var/lib/strudel-rag

WORKDIR /app
COPY --from=build /usr/local/bin/strudel-rag /usr/local/bin/strudel-rag
COPY config.example.toml ./strudel-rag.toml
COPY corpus/sources.toml ./corpus/sources.toml

ENV STRUDEL_RAG_CONFIG=/app/strudel-rag.toml \
    STRUDEL_RAG_DATA_DIR=/var/lib/strudel-rag \
    STRUDEL_RAG_BIND=0.0.0.0:50051
USER strudel-rag:strudel-rag
EXPOSE 50051

# Transport liveness only: remote info also succeeds when the index is not ready.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD ["strudel-rag", "remote", "--endpoint", "http://127.0.0.1:50051", "--timeout-secs", "5", "info"]

ENTRYPOINT ["strudel-rag"]
CMD ["serve"]
