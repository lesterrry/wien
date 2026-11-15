#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
suite="${1:-all}"
if [[ $# -gt 1 || ( "$suite" != all && "$suite" != client && "$suite" != rust ) ]]; then
    echo "Usage: bash scripts/test.sh [all|client|rust]" >&2
    exit 2
fi

step() {
    local title="$1"
    shift
    printf '\n%s\n' "$title"
    "$@"
}

# Fail before doing expensive work when a required local dependency is missing.
if [[ "$suite" != rust ]]; then
    command -v pnpm >/dev/null
    if [[ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]]; then
        echo "Tests require Node.js 22, matching CI." >&2
        exit 1
    fi
fi
if [[ "$suite" != client ]]; then
    command -v cargo >/dev/null
    if ! docker info >/dev/null 2>&1; then
        echo "Tests require a running Docker daemon for disposable PostgreSQL. Start Docker/Colima and retry." >&2
        exit 1
    fi
fi

client_checks() (
    cd client
    step "Install locked client dependencies" pnpm install --frozen-lockfile
    step "Client lint, formatting, types and unit tests" pnpm test
    step "Build desktop client" pnpm build
    step "Build web client" pnpm build:web
    step "Install Playwright Chromium" pnpm exec playwright install --with-deps chromium
    step "Browser workspace" pnpm test:web
    step "EN/RU localization" node scripts/localization-smoke.mjs
    step "Storefront UI" node scripts/storefront-smoke.mjs
    step "Payment UI" node scripts/payments-smoke.mjs
)

rust_tests() (
    # Always create our own server, even if DATABASE_URL is set in the shell.
    # Random loopback ports let concurrent runs coexist with development services.
    local container_id=""
    cleanup() {
        local status=$?
        trap - EXIT
        if [[ -n "$container_id" ]]; then
            docker rm --force --volumes "$container_id" >/dev/null || status=1
        fi
        exit "$status"
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    container_id=$(docker run --detach --rm --label wien.test=postgres \
        -e POSTGRES_USER=wien_test \
        -e POSTGRES_PASSWORD=test-only-password \
        -e POSTGRES_DB=wien_test \
        -p 127.0.0.1::5432 postgres:18-alpine)
    local ready=false
    for ((attempt = 0; attempt < 60; attempt++)); do
        if docker exec "$container_id" pg_isready -h 127.0.0.1 -U wien_test -d wien_test >/dev/null 2>&1; then
            ready=true
            break
        fi
        sleep 1
    done
    if [[ "$ready" != true ]]; then
        docker logs "$container_id" >&2
        echo "Test PostgreSQL did not become ready within 60 seconds." >&2
        exit 1
    fi
    local address
    address=$(docker port "$container_id" 5432/tcp)
    export DATABASE_URL="postgresql://wien_test:test-only-password@$address/wien_test"
    # The complete workspace suite, including DB tests marked #[ignore].
    cargo test --locked --workspace --all-features -- --include-ignored
)

rust_checks() {
    step "Rust formatting" cargo fmt --all -- --check
    step "Rust Clippy" cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
    step "Rust tests, including PostgreSQL" rust_tests
    step "Generated HTTP contract" bash server/scripts/generate-http.sh --check
}

if [[ "$suite" != rust ]]; then
    client_checks
fi
if [[ "$suite" != client ]]; then
    rust_checks
fi
printf '\nAll checks passed (%s).\n' "$suite"
