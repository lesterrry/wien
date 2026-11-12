use std::{path::PathBuf, process::ExitCode, sync::Arc};

use clap::{Args, Parser, Subcommand, ValueEnum};
use serde_json::{Value, json};
use strudel_rag_core::{
    Config, DocumentKind, DocumentReference, Error, RagEngine, Result, SearchFilters, SearchIntent,
    SearchRequest, build_index, provider_from_config,
};
use strudel_rag_grpc::RemoteClient;

#[derive(Parser)]
#[command(
    name = "strudel-rag",
    version,
    about = "Local and gRPC Strudel retrieval (JSON output)"
)]
struct Cli {
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    #[arg(long, global = true)]
    allow_fixture: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Import source documents into atomic normalized snapshots.
    Ingest {
        #[arg(long = "source")]
        sources: Vec<String>,
        #[arg(long, conflicts_with = "examples_dir")]
        local_root: Option<PathBuf>,
        #[arg(long)]
        examples_dir: Option<PathBuf>,
    },
    /// Build a hybrid index; unchanged embeddings are reused.
    Index {
        #[arg(long)]
        rebuild: bool,
    },
    /// Search the local immutable index generation.
    Search(SearchArgs),
    /// Read a complete document or chunk from the local generation.
    Get(GetArgs),
    /// Report local corpus readiness and provenance without network calls.
    Info,
    /// Serve authenticated gRPC, health, and reflection on one endpoint.
    Serve {
        #[arg(long)]
        bind: Option<std::net::SocketAddr>,
    },
    /// Inspect local integrity; embedding requests are explicitly opt-in.
    Doctor {
        #[arg(long)]
        check_embeddings: bool,
    },
    /// Evaluate ranked unique-document retrieval against JSONL labels.
    Eval {
        #[arg(long)]
        dataset: PathBuf,
        #[arg(long, default_value_t = 5)]
        k: usize,
    },
    /// Use a real gRPC client; no local index or embedding provider is opened.
    Remote(RemoteArgs),
}

#[derive(Clone, Copy, ValueEnum)]
enum IntentArg {
    Api,
    Musical,
    Example,
    Mixed,
}

impl From<IntentArg> for SearchIntent {
    fn from(value: IntentArg) -> Self {
        match value {
            IntentArg::Api => Self::Api,
            IntentArg::Musical => Self::Musical,
            IntentArg::Example => Self::Example,
            IntentArg::Mixed => Self::Mixed,
        }
    }
}

#[derive(Clone, Copy, ValueEnum)]
enum KindArg {
    Api,
    Theory,
    Example,
}

impl From<KindArg> for DocumentKind {
    fn from(value: KindArg) -> Self {
        match value {
            KindArg::Api => Self::Api,
            KindArg::Theory => Self::Theory,
            KindArg::Example => Self::Example,
        }
    }
}

#[derive(Args)]
struct SearchArgs {
    #[arg(long)]
    query: String,
    #[arg(long, value_enum, default_value = "mixed")]
    intent: IntentArg,
    #[arg(long)]
    top_k: Option<usize>,
    #[arg(long = "kind", value_enum)]
    kinds: Vec<KindArg>,
    #[arg(long = "source-id")]
    source_ids: Vec<String>,
    #[arg(long = "tag")]
    tags: Vec<String>,
    #[arg(long = "language")]
    languages: Vec<String>,
}

impl From<SearchArgs> for SearchRequest {
    fn from(value: SearchArgs) -> Self {
        Self {
            query: value.query,
            intent: value.intent.into(),
            top_k: value.top_k,
            filters: SearchFilters {
                kinds: value.kinds.into_iter().map(Into::into).collect(),
                source_ids: value.source_ids,
                tags: value.tags,
                languages: value.languages,
            },
        }
    }
}

#[derive(Args)]
#[group(required = true, multiple = false)]
struct DocumentIdArgs {
    #[arg(long)]
    document_id: Option<String>,
    #[arg(long)]
    chunk_id: Option<String>,
}

#[derive(Args)]
struct GetArgs {
    #[command(flatten)]
    id: DocumentIdArgs,
    #[arg(long)]
    parent: bool,
}

impl GetArgs {
    fn reference(self) -> Result<(DocumentReference, bool)> {
        let reference = match (self.id.document_id, self.id.chunk_id) {
            (Some(id), None) => DocumentReference::DocumentId(id),
            (None, Some(id)) => DocumentReference::ChunkId(id),
            _ => {
                return Err(Error::InvalidArgument(
                    "supply exactly one document or chunk ID".into(),
                ));
            }
        };
        Ok((reference, self.parent))
    }
}

#[derive(Args)]
struct RemoteArgs {
    #[arg(long, global = true)]
    endpoint: Option<String>,
    #[arg(long, global = true)]
    timeout_secs: Option<u64>,
    #[command(subcommand)]
    command: RemoteCommand,
}

#[derive(Subcommand)]
enum RemoteCommand {
    Search(SearchArgs),
    Get(GetArgs),
    Info,
    Health,
}

#[tokio::main]
async fn main() -> ExitCode {
    service_runtime::init_logging();
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) {
                let _ = error.print();
                return ExitCode::SUCCESS;
            }
            write_error("usage", &error.to_string());
            return ExitCode::from(2);
        }
    };
    match run(cli).await {
        Ok(output) => {
            match serde_json::to_string(&output) {
                Ok(json) => println!("{json}"),
                Err(_) => {
                    write_error("internal", "cannot serialize command response");
                    return ExitCode::FAILURE;
                }
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            let (code, status) = match &error {
                Error::Config(_) | Error::InvalidArgument(_) => ("usage_config", 2),
                Error::NotReady(_) => ("not_ready", 1),
                Error::NotFound(_) => ("not_found", 1),
                Error::Provider(_) => ("provider", 1),
                Error::Corrupt(_) => ("corrupt", 1),
                _ => ("runtime", 1),
            };
            write_error(code, &error.to_string());
            ExitCode::from(status)
        }
    }
}

fn write_error(code: &str, message: &str) {
    eprintln!("{}", json!({"error": {"code": code, "message": message}}));
}

fn to_json(value: impl serde::Serialize) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}

fn engine(config: &Config) -> Result<RagEngine> {
    RagEngine::open(config, provider_from_config(config)?)
}

async fn run(cli: Cli) -> Result<Value> {
    let mut config = Config::load(cli.config.as_deref())?;
    if let Some(path) = cli.data_dir {
        config.data_dir = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()?.join(path)
        };
    }
    config.allow_fixture = cli.allow_fixture;
    match cli.command {
        Command::Remote(args) => {
            if let Some(endpoint) = args.endpoint {
                config.client.endpoint = endpoint;
            }
            if let Some(timeout) = args.timeout_secs {
                if timeout == 0 {
                    return Err(Error::InvalidArgument(
                        "--timeout-secs must be positive".into(),
                    ));
                }
                config.client.timeout_secs = timeout;
            }
            let mut remote = RemoteClient::connect(&config.client).await?;
            match args.command {
                RemoteCommand::Search(args) => to_json(remote.search(args.into()).await?),
                RemoteCommand::Get(args) => {
                    let (id, parent) = args.reference()?;
                    to_json(remote.get_document(id, parent).await?)
                }
                RemoteCommand::Info => to_json(remote.corpus_info().await?),
                RemoteCommand::Health => to_json(json!({"serving": remote.health().await?})),
            }
        }
        command => {
            if let Command::Serve { bind: Some(bind) } = &command {
                config.server.bind = *bind;
            }
            config.validate()?;
            match command {
                Command::Ingest {
                    sources,
                    local_root,
                    examples_dir,
                } => {
                    if local_root.is_some() && sources.len() != 1 {
                        return Err(Error::InvalidArgument(
                            "--local-root requires exactly one --source".into(),
                        ));
                    }
                    if examples_dir.is_some()
                        && (sources.len() != 1 || sources[0] != "local-examples")
                    {
                        return Err(Error::InvalidArgument(
                            "--examples-dir requires --source local-examples".into(),
                        ));
                    }
                    let options = strudel_rag_core::ingest::IngestOptions {
                        local_root,
                        examples_dir,
                    };
                    to_json(
                        strudel_rag_core::ingest::ingest_with_options(&config, &sources, &options)
                            .await?,
                    )
                }
                Command::Index { rebuild } => {
                    to_json(build_index(&config, provider_from_config(&config)?, rebuild).await?)
                }
                Command::Search(args) => to_json(engine(&config)?.search(args.into()).await?),
                Command::Get(args) => {
                    let (id, parent) = args.reference()?;
                    to_json(engine(&config)?.get_document(id, parent)?)
                }
                Command::Info => to_json(engine(&config)?.corpus_info()),
                Command::Serve { .. } => {
                    let engine = Arc::new(engine(&config)?);
                    tracing::info!(address = %config.server.bind, "starting gRPC server");
                    strudel_rag_grpc::serve(
                        &config,
                        Some(engine),
                        service_runtime::shutdown_signal(),
                    )
                    .await?;
                    Ok(json!({"stopped": true}))
                }
                Command::Doctor { check_embeddings } => doctor(&config, check_embeddings).await,
                Command::Eval { dataset, k } => {
                    if !(1..=50).contains(&k) {
                        return Err(Error::InvalidArgument(
                            "--k must be between 1 and 50".into(),
                        ));
                    }
                    let engine = engine(&config)?;
                    to_json(strudel_rag_core::eval::evaluate(&config, &engine, &dataset, k).await?)
                }
                Command::Remote(_) => unreachable!("remote handled before local configuration"),
            }
        }
    }
}

fn inspect_sources(config: &Config) -> Value {
    let manifest = match strudel_rag_core::ingest::load_manifest(&config.sources_manifest) {
        Ok(manifest) => json!({"valid": true, "sources": manifest.sources.len()}),
        Err(error) => json!({"valid": false, "error": error.to_string()}),
    };
    let snapshots = match strudel_rag_core::store::load_sources(config) {
        Ok(snapshots) => snapshots,
        Err(error) => {
            return json!({
                "manifest": manifest,
                "normalized": {"valid": false, "error": error.to_string()},
                "raw": {"valid": false, "checked": 0, "error": "normalized snapshots unavailable"}
            });
        }
    };
    let mut normalized_errors = Vec::new();
    let mut raw_errors = Vec::new();
    let mut checked = 0;
    let mut source_details = Vec::new();
    for snapshot in &snapshots {
        let mut ids = std::collections::BTreeSet::new();
        for document in &snapshot.documents {
            if document.content_hash != strudel_rag_core::content_hash(&document.content)
                || !ids.insert(&document.document_id)
            {
                normalized_errors.push(format!(
                    "{}: invalid content hash or duplicate document ID",
                    snapshot.source_id
                ));
            }
        }
        let pointer = config
            .data_dir
            .join("normalized")
            .join(&snapshot.source_id)
            .join("CURRENT");
        match (
            std::fs::read_to_string(pointer),
            serde_json::to_vec(snapshot),
        ) {
            (Ok(current), Ok(bytes)) if current.trim() == strudel_rag_core::sha256(&bytes) => {}
            _ => {
                normalized_errors.push(format!("{}: snapshot digest mismatch", snapshot.source_id))
            }
        }
        let raw_root = config.data_dir.join("raw").join(&snapshot.source_id);
        let revisions = std::fs::read_dir(&raw_root).and_then(|entries| {
            entries
                .map(|entry| entry.map(|entry| entry.path()))
                .collect::<std::io::Result<Vec<_>>>()
        });
        for (path, expected_hash) in &snapshot.raw_hashes {
            checked += 1;
            let safe_path = std::path::Path::new(path)
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)));
            let found = safe_path
                && revisions.as_ref().is_ok_and(|revisions| {
                    revisions.iter().any(|revision| {
                        std::fs::read(revision.join(path))
                            .is_ok_and(|bytes| strudel_rag_core::sha256(bytes) == *expected_hash)
                    })
                });
            if !found {
                raw_errors.push(format!(
                    "{}: raw evidence missing or hash mismatch for {path}",
                    snapshot.source_id
                ));
            }
        }
        source_details.push(json!({
            "source_id": snapshot.source_id,
            "revision": snapshot.revision,
            "documents": snapshot.documents.len(),
            "fixture": snapshot.fixture,
            "coverage_gaps": snapshot.coverage_gaps
        }));
    }
    json!({
        "manifest": manifest,
        "normalized": {"valid": normalized_errors.is_empty(), "sources": source_details, "errors": normalized_errors},
        "raw": {"valid": raw_errors.is_empty(), "checked": checked, "errors": raw_errors}
    })
}

async fn doctor(config: &Config, check_embeddings: bool) -> Result<Value> {
    let provider = provider_from_config(config)?;
    let engine = RagEngine::open(config, provider.clone())?;
    let info = engine.corpus_info();
    let source_integrity = inspect_sources(config);
    let embedding_check = if check_embeddings {
        let batch = provider
            .embed(&["strudel rag diagnostic".to_owned()])
            .await?;
        if batch.vectors.len() != 1 {
            return Err(Error::Provider(
                "diagnostic returned an unexpected embedding count".into(),
            ));
        }
        let vector = batch
            .vectors
            .first()
            .ok_or_else(|| Error::Provider("diagnostic returned no embedding".into()))?;
        let dimension = vector.len();
        if vector.is_empty()
            || vector.iter().any(|value| !value.is_finite())
            || vector.iter().all(|value| *value == 0.0)
        {
            return Err(Error::Provider(
                "diagnostic returned an invalid vector".into(),
            ));
        }
        if info
            .model
            .as_ref()
            .is_some_and(|model| model != &batch.model)
            || info.dimension.is_some_and(|expected| expected != dimension)
        {
            return Err(Error::NotReady(
                "live embedding model/dimension is incompatible with the index; rebuild required"
                    .into(),
            ));
        }
        Some(json!({"model": batch.model, "dimension": dimension, "compatible": true}))
    } else {
        None
    };
    Ok(json!({
        "config": {
            "data_dir": config.data_dir,
            "sources_manifest": config.sources_manifest,
            "embedding": {
                "provider": config.embedding.provider,
                "model": config.embedding.model,
                "dimensions": config.embedding.dimensions,
                "fingerprint": provider.identity().fingerprint()
            },
            "server_bind": config.server.bind,
            "fixture_allowed": config.allow_fixture
        },
        "sources": source_integrity,
        "corpus": info,
        "embedding_check": embedding_check,
        "network_checked": check_embeddings
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_and_remote_search_share_filters() {
        let cli = Cli::try_parse_from([
            "strudel-rag",
            "remote",
            "search",
            "--query",
            "euclid pulses",
            "--intent",
            "api",
            "--kind",
            "api",
            "--source-id",
            "strudel-api",
            "--tag",
            "rhythm",
            "--language",
            "en",
            "--top-k",
            "5",
            "--endpoint",
            "http://localhost:12345",
        ])
        .unwrap();
        let Command::Remote(remote) = cli.command else {
            panic!("expected remote");
        };
        assert_eq!(remote.endpoint.as_deref(), Some("http://localhost:12345"));
        let RemoteCommand::Search(args) = remote.command else {
            panic!("expected search");
        };
        let request: SearchRequest = args.into();
        assert_eq!(request.query, "euclid pulses");
        assert_eq!(request.intent, SearchIntent::Api);
        assert_eq!(request.top_k, Some(5));
        assert_eq!(request.filters.kinds, vec![DocumentKind::Api]);
        assert_eq!(request.filters.source_ids, vec!["strudel-api"]);
        assert_eq!(request.filters.tags, vec!["rhythm"]);
        assert_eq!(request.filters.languages, vec!["en"]);
    }

    #[test]
    fn get_requires_exactly_one_reference() {
        assert!(Cli::try_parse_from(["strudel-rag", "get"]).is_err());
        assert!(
            Cli::try_parse_from([
                "strudel-rag",
                "get",
                "--document-id",
                "doc_x",
                "--chunk-id",
                "chk_x",
            ])
            .is_err()
        );
        let cli = Cli::try_parse_from([
            "strudel-rag",
            "remote",
            "get",
            "--chunk-id",
            "chk_x",
            "--parent",
        ])
        .unwrap();
        let Command::Remote(remote) = cli.command else {
            panic!("expected remote");
        };
        let RemoteCommand::Get(args) = remote.command else {
            panic!("expected get");
        };
        let (reference, parent) = args.reference().unwrap();
        assert!(matches!(reference, DocumentReference::ChunkId(id) if id == "chk_x"));
        assert!(parent);
    }

    #[test]
    fn fixture_permission_is_global_and_explicit() {
        let cli = Cli::try_parse_from([
            "strudel-rag",
            "index",
            "--allow-fixture",
            "--config",
            "config.fixture.toml",
        ])
        .unwrap();
        assert!(cli.allow_fixture);
        assert_eq!(cli.config, Some(PathBuf::from("config.fixture.toml")));
        assert!(
            !Cli::try_parse_from(["strudel-rag", "info"])
                .unwrap()
                .allow_fixture
        );
    }
}
