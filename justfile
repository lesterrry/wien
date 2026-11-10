[default]
[private]
default:
    @just --list

# Launch the desktop client in development mode
run-client:
    pnpm --dir client dev

# Build the desktop client
build-client:
    pnpm --dir client build

# Launch the local AI server
run-server:
    cargo run --manifest-path server/Cargo.toml --locked

# Build the local AI server
build-server:
    cargo build --manifest-path server/Cargo.toml --locked --release

# Export OpenAPI and generate VS Code HTTP requests
generate:
    bash server/scripts/generate-http.sh

# Check lint, formatting, types, and run tests
test:
    pnpm --dir client test
    cargo fmt --manifest-path server/Cargo.toml --all -- --check
    cargo clippy --manifest-path server/Cargo.toml --locked --all-targets -- -D warnings
    cargo test --manifest-path server/Cargo.toml --locked
