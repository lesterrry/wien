[default]
[private]
default:
    @just --list

# Prepare env
init:
    @if [ -e .env ] || [ -L .env ]; then echo 'error: .env already exists' >&2; exit 1; fi
    (set -C; cat .env.example > .env)

# Launch the desktop client in development mode
run-client:
    pnpm --dir client dev

# Package the desktop client and print its location
build-client:
    pnpm --dir client package

# Launch the browser client; API requests use client/config.yaml
run-web:
    pnpm --dir client dev:web

# Build the static browser client
build-web:
    pnpm --dir client build:web

# Launch local AI server and RAG with Codex credentials mounted; Ctrl+C stops both
run-server:
    just --dotenv-path .env --command sh -cu 'export COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml}${COMPOSE_PATH_SEPARATOR:-:}compose.codex.yaml"; exec docker compose up --build server skill'

# Build both production Rust binaries
build-server:
    cargo build --locked --release -p wien-server -p strudel-rag-cli

# Export OpenAPI and generate VS Code HTTP requests
generate:
    bash server/scripts/generate-http.sh

# Run the complete CI suite, including browser and disposable PostgreSQL tests
test:
    bash scripts/test.sh
