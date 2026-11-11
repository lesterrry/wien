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

# Check lint, formatting, types, and run tests
test:
    pnpm --dir client test
    cargo fmt --manifest-path server/Cargo.toml --all -- --check
    cargo clippy --manifest-path server/Cargo.toml --locked --all-targets -- -D warnings
    cargo test --manifest-path server/Cargo.toml --locked
