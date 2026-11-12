#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --locked -p strudel-rag-cli --features fixture-provider
fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/wien-rag-fixture.XXXXXX")
trap 'rm -rf "$fixture_dir"' EXIT
rag=(./target/debug/strudel-rag --config skill/config.fixture.toml --data-dir "$fixture_dir" --allow-fixture)
"${rag[@]}" ingest
"${rag[@]}" index
"${rag[@]}" search --query 'slow pattern cycles' --intent api --top-k 3
"${rag[@]}" eval --dataset skill/eval/fixture.jsonl --k 5
