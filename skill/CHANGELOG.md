# Changelog

## 0.1.0 — 2026-11-11

### Added

- Rust stable core, tonic/prost gRPC transport, and `strudel-rag` JSON CLI,
  including a real generated gRPC client and portable harness skill.
- Curated pinned Strudel MDX/JSDoc import, Pressbooks and local-directory
  importers, provenance/license metadata, derived examples and explicit
  source-only verification status.
- Markdown-aware chunks, stable content/document IDs, atomic source/index
  snapshots, writer locking, embedding cache and OpenAI-compatible HTTP
  embeddings. The technical fixture provider requires an explicit feature
  and runtime permission; there is no mock fallback.
- Filtered BM25 and exact-vector retrieval with reciprocal-rank fusion,
  provenance-preserving deduplication, full parent context and diagnostics.
- Health/reflection, bearer authentication, request limits, deadlines,
  graceful shutdown, diagnostic commands and labeled retrieval evaluation.

### Fixed

- Updated MDX extraction callers for the API catalog argument, restoring
  workspace compilation. Ingestion publishes selected JSDoc sources before MDX
  and supplies their API documents to embedded `JsDoc` references; MDX-only
  imports reuse published API snapshots. Qualified and bare Pattern names
  resolve with API provenance; missing names remain coverage gaps.
- Open Music Theory now imports the five downloaded `saved_html/` chapters by
  default. Saved HTML revisions use page-content SHA-256, not the surrounding
  repository's Git revision; canonical chapter IDs and attribution are retained.
- Removed the implementation/verification record from README; the corrected
  record is maintained below.

### Implementation record and observed checks (2026-11-11)

- Formatting check, all-feature workspace check, warnings-as-errors Clippy
  across all targets/features, and workspace tests completed successfully.
  All 38 tests passed, with zero failures or ignored tests.
- Both fixture-enabled and default CLI builds succeeded. The default binary
  rejected mock configuration even with runtime fixture permission; production
  corpus info remained available without embedding credentials.
- Fixture build and separate-process local/gRPC search/get/info/health smoke
  succeeded: eight documents, 13 chunks, dimension 64; remote search matched
  local JSON and parent retrieval matched the complete original fixture.
- Repeated fixture ingest/index retained IDs and generation, imported zero
  documents and reused all 13 embeddings with zero cache misses.
- Five English technical fixture cases achieved Recall@5=MRR@5=1.0. This is
  plumbing evidence, not real semantic or multilingual retrieval quality.
- Existing Strudel snapshots at pinned revision
  `0cb6341299229f739b5090be93528bb4f170d855` contain 143 documentation and
  242 API documents, including derived examples.
- Open Music Theory imported five downloaded Pressbooks chapters successfully
  without remote fetching or embedding credentials, replacing the earlier HTTP
  403 blocker. The imported theory source has no coverage gaps; canonical URLs,
  page-content revisions, chapter authors and license/media notices are retained.
  Notation images are represented by alt text, not transcriptions.
- Repeated theory ingestion imported zero and skipped five documents. The
  combined normalized corpus contains 390 documents across three sources.
  Production `doctor` validated all 27 stored raw payloads and normalized
  snapshots. Four omitted MDX notation images and 11 unresolved Strudel JSDoc
  names remain explicit coverage gaps in the existing Strudel snapshots.
- Offline real-eval selector validation covered 16 cases: all 18 selectors
  resolved exactly (13 Strudel and five theory). This validates labels and
  source availability, not semantic retrieval quality.
  The configured index is not ready: its embedding identity differs from the
  configured provider, so it must be rebuilt before real search/evaluation.

### Unverified live scenarios

No live embedding requests were made during these checks. Production embedding
indexing, RU/EN retrieval quality, real evaluation metrics, and production-model
remote smoke were not exercised against the configured provider. No Strudel
execution or audio listening is claimed.
