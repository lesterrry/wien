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

# Build the desktop client
build-client:
    pnpm --dir client build

# Build and launch the AI server and RAG; Ctrl+C stops both
run-server:
    docker compose up --build server skill

# Export OpenAPI and generate VS Code HTTP requests
generate:
    bash server/scripts/generate-http.sh

# Check both Rust services with the same pipeline as CI
check-rust:
    bash scripts/check-rust.sh

# Build both production Rust binaries
build-server:
    cargo build --locked --release -p wien-server -p strudel-rag-cli

# Exercise fixture retrieval without credentials or external APIs
smoke-rag:
    bash scripts/smoke-rag.sh

# Check lint, formatting, types, and run tests for all components
test:
    pnpm --dir client test
    just check-rust
