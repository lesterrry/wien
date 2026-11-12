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

# Launch local AI server and RAG with Codex credentials mounted; Ctrl+C stops both
run-server:
    just --dotenv-path .env --command sh -cu 'export COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml}${COMPOSE_PATH_SEPARATOR:-:}compose.codex.yaml"; exec docker compose up --build server skill'

# Export OpenAPI and generate VS Code HTTP requests
generate:
    bash server/scripts/generate-http.sh

# Build both production Rust binaries
build-server:
    cargo build --locked --release -p wien-server -p strudel-rag-cli

# Check lint, formatting, types, and run tests for all components
test:
    pnpm --dir client test
    cargo fmt --all -- --check
    cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
    cargo test --locked --workspace --all-features
    bash server/scripts/generate-http.sh --check
