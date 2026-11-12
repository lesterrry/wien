#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/check-workspace.py
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
bash server/scripts/generate-http.sh --check
# Release binaries must never inherit fixture features from the test build.
cargo build --locked --release -p wien-server -p strudel-rag-cli
bash scripts/smoke-rag.sh
