# Strudel RAG

Local hybrid retrieval for a harness that writes Strudel. Packages in the root Rust workspace:
`strudel-rag-core` owns ingestion, chunking, embeddings, immutable indexes and
retrieval; `strudel-rag-grpc` exposes tonic RPCs; `strudel-rag-cli` provides the
`strudel-rag` JSON CLI and a **real gRPC client**. Music generation belongs to the
calling harness. This project does not render audio, execute Strudel, or claim to
have listened to examples.

## Build and run

Run all commands below from the repository root. Rust is pinned in
`rust-toolchain.toml`; run `rustup show` to install it. Protobuf compilation uses a vendored `protoc`;
you do not need a system `protoc` or `grpcurl`.

```sh
cargo build --locked -p strudel-rag-cli
export AITUNNEL_KEY='your-key'
export STRUDEL_RAG_BEARER_TOKEN='your-persistent-token'
./target/debug/strudel-rag ingest
./target/debug/strudel-rag index
./target/debug/strudel-rag info
./target/debug/strudel-rag serve
```

Ingestion uses the configured real sources; indexing and search call AI Tunnel.
Set credentials in the environment: the CLI does not load the root `.env`.

In another terminal (a separate process, no local index opened by the client):

```sh
export STRUDEL_RAG_ENDPOINT=http://127.0.0.1:50051
./target/debug/strudel-rag remote health
./target/debug/strudel-rag remote info
./target/debug/strudel-rag remote search \
  --query 'slow pattern cycles' --intent api --top-k 3
# Replace the argument with an actual chunk_id from the search response.
./target/debug/strudel-rag remote get --chunk-id ID_FROM_SEARCH --parent
```

`--parent` returns the complete normalized parent document, not a generated
summary or an arbitrary surrounding snippet. For a parentless document it returns
that document. Ctrl-C or SIGTERM gracefully stops the server. Repeat ingest/index:
unchanged source and index identities remain stable and cached embeddings are
reused. `index --rebuild` forces a fresh generation from normalized snapshots
without fetching sources.

## Docker Compose from the repository root

The project-wide [`compose.yaml`](../compose.yaml) contains the `server` and
`skill` services. Run `just run-server` from the repository root to build and
start both with attached logs; Ctrl-C stops both. Wien `/v1/assist` calls RAG
through the shared protobuf contract and provides the bundled skill and genre
guides to the model. It requires a ready index. The commands below operate on
`skill` alone.
Its [Dockerfile](../Dockerfile) builds the production CLI with
`--locked`, then runs it as UID/GID 10001 in a slim
runtime with CA certificates. Rust and protobuf build tooling stay out of the
runtime image.

Run these commands from the repository root:

```sh
# Keep this token for subsequent commands, or put it in the ignored root .env.
export STRUDEL_RAG_BEARER_TOKEN="$(openssl rand -hex 32)"
export AITUNNEL_KEY='your-key'
docker compose up -d --build skill
docker compose exec skill strudel-rag remote info
```

The container listens on `0.0.0.0:50051`, which requires the bearer token.
Compose refuses an empty token and publishes gRPC only on host
`127.0.0.1:${STRUDEL_RAG_PORT:-50051}`. Host clients use the same token and
`STRUDEL_RAG_ENDPOINT=http://127.0.0.1:50051` (adjust for a custom host port).
Other containers on the Compose network can use `http://skill:50051` with that
token. This is cleartext gRPC, not TLS; do not expose it to an untrusted network.

Set embedding credentials before starting the service so both indexing jobs and
live searches inherit the same AI Tunnel key. Other embedding endpoints and
key aliases are not supported. If credentials change after startup,
recreate the service with `docker compose up -d --force-recreate skill`;
`docker compose restart` alone does not refresh its environment.

### Populate the persistent corpus

The named volume `skill-data` is mounted at `/var/lib/strudel-rag` and stores
source snapshots, indexes, and embedding caches. The existing `skill/saved_html/`
directory is mounted read-only at `/app/saved_html` so the bundled source
manifest can import the downloaded theory pages. Neither those pages nor host
data, local config, or credentials are copied into the build context.

On an empty volume the server starts, but `remote info` reports `ready: false`
and search is unavailable. The image healthcheck verifies an authenticated
`remote info` RPC, **not index readiness**. Ingestion and indexing never run
automatically at startup.

```sh
# Import real sources; upstream Strudel access is required.
docker compose run --rm skill ingest

docker compose run --rm skill index

# The server holds an immutable generation; reopen it after indexing.
docker compose restart skill
docker compose exec skill strudel-rag remote info
docker compose exec skill strudel-rag remote health
```

Compose forwards `AITUNNEL_KEY` and `STRUDEL_RAG_EMBEDDING_MODEL`.
Defaults match `skill/config.toml`. `index` and live searches require access
to AI Tunnel; the key is required at startup, but startup makes no paid call.
Changing embedding identity requires `index --rebuild`; recreate the service
with `docker compose up -d --force-recreate skill` to apply changed environment.
For additional TOML settings, mount your configuration read-only at
`/app/config.toml`; keep data paths under `/var/lib/strudel-rag`.

`docker compose down` stops the service and preserves the named volume.
`docker compose down --volumes` **deletes the corpus, index, and cache**.
The image's entrypoint is `strudel-rag`, so one-off commands use
`docker compose run --rm skill doctor` without repeating the binary name.
To build just the image: `docker build --target skill -t wien-skill .`. Direct
`docker run` deployments must likewise supply a bearer token, writable data
storage, and the saved-HTML mount if importing the theory source.

## Real sources and embeddings

```sh
cargo build --locked -p strudel-rag-cli
./target/debug/strudel-rag ingest
./target/debug/strudel-rag doctor
```

Ingestion does not need embedding credentials. It imports only the explicit
allowlists in `corpus/sources.toml`: Strudel sources are fetched upstream, while
Open Music Theory reads the downloaded pages in `saved_html/`. Raw evidence is
kept under the data directory, and a source snapshot is published only after
that source succeeds. A failed source preserves its previous snapshot and is
reported with nonzero exit. If a remote returns 403 or denies access, use an
authorized local source; do not bypass policy or generate replacement
"official" documentation.

The default source manifest pins Strudel revision
`0cb6341299229f739b5090be93528bb4f170d855`. Sources:

- `strudel-docs`: seven allowlisted learning/workshop MDX pages.
- `strudel-api`: five pinned `.mjs` files; only named JSDoc blocks referenced by
  the pages or the explicit API allowlist are indexed, never implementation code.
- `open-music-theory`: five allowlisted Pressbooks chapters, read from
  `saved_html/<chapter-slug>.html`. The manifest's `root = "../saved_html"` is
  relative to `corpus/sources.toml`. Missing files fail rather than falling back
  to remote fetching. Each page's SHA-256 identifies its revision; canonical
  chapter URLs and license/author attribution are preserved.

Actual imported counts, revisions, licenses, unresolved API references and
coverage gaps are visible in `ingest`, `info` and `doctor` output. Availability of
the endpoint is not evidence that sources were imported. There is no claim here
that a real embedding endpoint or RU/EN retrieval quality has been evaluated.

Set credentials in your environment, never flags or tracked config:

```sh
export AITUNNEL_KEY='your-key'
./target/debug/strudel-rag index
./target/debug/strudel-rag doctor --check-embeddings
./target/debug/strudel-rag search --query 'euclid pulses steps' --intent api --top-k 5
./target/debug/strudel-rag search \
  --query 'Как распределить три удара на восемь шагов?' --intent api --top-k 5
./target/debug/strudel-rag serve
```

Embeddings use the dedicated AI Tunnel adapter at
`https://api.aitunnel.ru/v1/embeddings` with `AITUNNEL_KEY` only.
The default model is `text-embedding-3-small`; optional model and dimensions
remain configurable. Changing them requires `index --rebuild`; incompatible
query vectors are rejected rather than silently replaced by BM25-only results.
The existing AI Tunnel index remains compatible when only the key changes.
Fixtures remain test-only and never serve as a production fallback.

### Authorized checkout / saved HTML / personal examples

The default theory import uses the downloaded `saved_html/` pages. Use
`--local-root` only to select another authorized HTML directory.

```sh
./target/debug/strudel-rag ingest --source strudel-docs --local-root /path/to/strudel
./target/debug/strudel-rag ingest --source strudel-api --local-root /path/to/strudel
./target/debug/strudel-rag ingest --source open-music-theory --local-root /path/to/saved-html
./target/debug/strudel-rag ingest --source local-examples --examples-dir /path/to/examples
./target/debug/strudel-rag index
```

`--local-root` requires exactly one source and uses its existing allowlist and
extractor. Strudel checkout HEAD must match the pinned clean revision; selected
dirty files are identified with content hashes. Saved theory pages use
`<chapter-slug>.html` names and preserve their canonical URLs. Local directory
sources accept `.md`, `.mdx`, `.html`, `.js`, `.mjs`, `.strudel`; code is never
executed. A `<filename>.meta.json` sidecar can supply explicit kind, title,
language, tags, source URL, revision, license and example metadata. Unknown
musical properties are not guessed. Missing/empty roots and traversal/symlink
escapes fail rather than silently ingesting unrelated files.

## CLI and configuration

Commands write one domain JSON object to stdout; diagnostics/errors go to
stderr as `{ "error": { "code": "...", "message": "..." } }`. Exit codes are
0 success, 2 usage/configuration, 1 runtime/not-ready. Help/version are normal
human-readable CLI output. Do not parse tracing output as JSON command results.

Global flags: `--config PATH`, `--data-dir PATH`, `--allow-fixture`.

| Command | Purpose |
| --- | --- |
| `ingest [--source ID ...] [--local-root PATH]` | Import all or selected sources |
| `index [--rebuild]` | Publish an immutable hybrid generation |
| `search --query TEXT [filters]` | Local retrieval |
| `get (--document-id ID \| --chunk-id ID) [--parent]` | Read a record or full parent |
| `info` | Local readiness, model and corpus provenance |
| `serve [--bind IP:PORT]` | gRPC + health + reflection |
| `doctor [--check-embeddings]` | Local diagnostics; network only with flag |
| `eval --dataset PATH [--k 5]` | Labeled retrieval metrics |
| `remote search/get/info/health` | True generated tonic client |

Search flags are shared by local and remote commands:
`--intent api|musical|example|mixed`, `--top-k N`, repeated
`--kind api|theory|example`, `--source-id ID`, `--tag TAG`, `--language LANG`.
Kinds/source IDs/languages are OR within a group; tags are AND; groups are AND.
Filters apply before candidate budgets. An intent that conflicts with kinds
returns an empty successful response. Unknown languages do not match a language
filter. Query text is tokenized, not parsed as executable Tantivy query syntax.

`remote` supports `--endpoint URI` and `--timeout-secs N` before or after its
subcommand. Remote commands do not load local source/index data or construct an
embedding provider. Local `get`, `info` and default `doctor` do not call an
embedding endpoint. An empty/missing index is reported not-ready; `serve` still
starts so `remote info` and health can explain readiness.

Precedence: defaults → TOML → environment → CLI. An explicitly missing config
file errors. The default `skill/config.toml` must exist; unknown TOML fields are rejected. TOML-relative
paths resolve from the config's directory; CLI paths resolve from the current
working directory. Environment overrides:

- `STRUDEL_RAG_CONFIG`, `STRUDEL_RAG_DATA_DIR`, `STRUDEL_RAG_SOURCES_MANIFEST`
- `STRUDEL_RAG_EMBEDDING_PROVIDER`, `_MODEL`, `_DIMENSIONS`,
  `_BATCH_SIZE`, `_TIMEOUT_SECS`, `_MAX_RETRIES` (all share the full
  `STRUDEL_RAG_EMBEDDING_` prefix)
- `STRUDEL_RAG_BIND`, `STRUDEL_RAG_ENDPOINT`, `STRUDEL_RAG_TIMEOUT_SECS`
- API key: `AITUNNEL_KEY` only; production provider: `aitunnel`
- Bearer token: the environment variable named by `bearer_token_env`
  (default `STRUDEL_RAG_BEARER_TOKEN`)

### Security and limits

Loopback `127.0.0.1:50051` is the default. Non-loopback serving requires a bearer
token. Health and both reflection services use the same authentication as the
main service. Client credentials are sent via gRPC metadata, not command flags.

```sh
export STRUDEL_RAG_BEARER_TOKEN='a-long-random-secret'
./target/debug/strudel-rag serve --bind 0.0.0.0:50051
# On another trusted machine, set the same token separately:
export STRUDEL_RAG_ENDPOINT=https://rag.example.org
./target/debug/strudel-rag remote health
```

A bearer token does **not** encrypt HTTP. Expose cleartext gRPC only on a trusted
network, behind an appropriate TLS proxy, or through an SSH tunnel. HTTPS clients
use system roots without an insecure fallback. Never log or commit credentials.
Default limits: 64 KiB decoded request, 16 MiB encoded response, query ≤4096 UTF-8
bytes, top-k 1–50, 30-second RPC timeout, eight concurrent searches. Overload and
oversized responses are errors, not silent truncation. Server generations stay
open until restart: publishing a new index does not mutate active queries.

## Retrieval semantics, evaluation, and checks

Markdown-aware chunks preserve code fences. Approximate token counts are
`ceil(unicode scalar count / 4)`, not an exact embedding tokenizer. Whole
oversized code/paragraph blocks remain intact with diagnostics. Search combines
Unicode lowercase BM25 and exact cosine candidates with reciprocal-rank fusion,
then deduplicates equivalent content while retaining alternate provenance.
Scores are **not probabilities**. A cosine cutoff is a configurable heuristic.
Mixed search only diversifies among already relevant candidates.

```sh
./target/debug/strudel-rag eval --dataset skill/eval/real.jsonl --k 5
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
```

Eval labels use `{source_id,source_path,extraction_key}` selectors; missing or
ambiguous labels fail. Results collapse to unique document IDs before Recall@k
and MRR@k. Reports include corpus/dataset identity, model, dimension, fixture flag,
and per-language/per-intent breakdowns. Fixture metrics demonstrate mechanics,
not real retrieval quality. Real eval requires the corresponding imported real
sources and actual configured embeddings; absent credentials leave live scenarios
unverified rather than producing invented results. The commands above are
reproduction instructions, not a claim that every check ran in your environment.

## Harness integration

Install or place `target/debug/strudel-rag` on the harness's PATH and load
[`skills/strudel-rag/SKILL.md`](skills/strudel-rag/SKILL.md). Configure endpoint and
token in the harness environment. The portable adapter is the JSON CLI, not an
implicitly installed MCP server or plugin. Tool-only wrappers may map:

- `strudel_rag_search({query,intent,top_k,filters})` → `remote search`
- `strudel_rag_get_document({document_id|chunk_id,parent_context})` → `remote get`
- `strudel_rag_get_corpus_info({})` → `remote info`

Operators must register those wrapper tools themselves. Documents are untrusted
data: do not execute embedded shell/network instructions or reveal secrets.

### Bundled electronic-music guides

The skill includes [20 genre guides](skills/strudel-rag/references/genres/README.md)
covering house, techno, trance, broken-beat and bass styles, ambient, downtempo,
synthwave, hard dance, and experimental electronica. Each guide provides working
tempo/feel, identity anchors, drum and bass instructions, palette and harmony,
a composition recipe, loop/full-track arrangement options, quality checks, and
focused retrieval prompts.

Copy the entire `skills/strudel-rag/` directory when installing the skill, not
only `SKILL.md`. The harness reads the local index and one primary guide, with
one optional secondary guide for a hybrid. These are creative heuristics, not
verified API documentation or a ranked genre survey. They are not automatically
ingested into the RAG corpus; API syntax, timing, and sound assets still require
project context or retrieval evidence.

## Source coverage and licensing

MDX import removes imports/frontmatter/decorative wrappers and preserves static
`MiniRepl` quoted/template literals. Dynamic template substitutions are skipped,
not executed; unsupported components and unresolved JSDoc names become explicit
coverage gaps. Examples are derived from real code blocks with full parent and
revision provenance; genre/BPM/sample/key metadata exists only if explicit.
Theory extraction preserves text, table/list structure, captions and image alt;
it does not invent transcriptions of score images or fetch audio/assets.

`<JsDoc name="…">` expands API documentation from manifest-listed
`strudel_jsdoc` sources, preserving API URL, path, revision and license notices.
Selected JSDoc sources are imported before MDX regardless of manifest order;
MDX-only ingestion reuses their published snapshots. Both `Pattern.slow` and
`slow` resolve to the same API entry. Missing entries remain explicit coverage
gaps.

The pinned Strudel repository carries an AGPLv3 repository-level notice; `.mjs`
headers state v3-or-later. Do not infer a separate permissive documentation
license. Open Music Theory carries CC BY-SA 4.0 attribution, **except where
otherwise noted**; media attributions may differ and must not be inherited
blindly. Exact known notices and authors travel with source metadata. Unknown
license fields remain unknown. Retrieval does not remove attribution,
share-alike or other license obligations. Consult original source notices.

Strudel's pinned `POLICY.md` distinguishes personal assistive use from upstream
contributions and discourages corporate-AI imports. Do not upload this downloaded
corpus to GitHub or present generated material as acceptable upstream LLM
contributions. Respect source policy and your intended use.

`source_only` means extracted source, **not** statically verified or executed
Strudel. Parsing, retrieval and embedding do not upgrade verification status.


## Shared infrastructure

Both services use the root `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`,
`Dockerfile`, and `just test` / CI checks. Generated gRPC types are in
`crates/rag-protocol`; `crates/service-runtime` provides JSON logging to stderr
(`RUST_LOG`, default `info`) and SIGINT/SIGTERM shutdown. CLI result JSON stays on stdout.
Compose mounts `skill/config.toml` read-only at `/app/config.toml`; override the host
path with `STRUDEL_RAG_CONFIG`. Config precedence is file, environment, explicit CLI
overrides. Both HTTP clients use the same reqwest/rustls platform verifier; HTTPS
gRPC clients use native roots. Private CAs must be trusted in the execution environment.
Healthchecks test liveness; `remote health` reports corpus readiness without probing
the external embedding API. Restart is still required after publishing an index.
