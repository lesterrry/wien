//! Allowlisted source ingestion. Extraction never executes JavaScript or MDX.
mod parsers;

use crate::store::{WriterLock, load_sources, publish_source};
use crate::{
    Config, Document, DocumentKind, Error, ExampleMetadata, LicenseInfo, Result, SourceRef,
    SourceSnapshot, VerificationStatus, document_id, sha256,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use walkdir::WalkDir;

#[derive(Debug, Clone, Default)]
pub struct IngestOptions {
    pub local_root: Option<PathBuf>,
    pub examples_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceIngestReport {
    pub source_id: String,
    pub documents: usize,
    pub imported: usize,
    pub skipped: usize,
    pub revision: Option<String>,
    pub raw_hashes: BTreeMap<String, String>,
    pub coverage_gaps: Vec<String>,
    pub fixture: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestReport {
    pub sources: Vec<SourceIngestReport>,
    pub documents: usize,
    pub imported: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourcesManifest {
    pub sources: Vec<SourceSpec>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceSpec {
    pub source_id: String,
    #[serde(rename = "type")]
    pub source_type: String,
    pub extractor: String,
    pub root: Option<PathBuf>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default)]
    pub reference_paths: Vec<String>,
    #[serde(default)]
    pub evidence_paths: Vec<String>,
    #[serde(default)]
    pub api_names: Vec<String>,
    pub base_url: Option<String>,
    pub revision: Option<String>,
    pub language: Option<String>,
    pub license: Option<LicenseInfo>,
    pub kind: Option<DocumentKind>,
    #[serde(default)]
    pub fixture: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sidecar {
    kind: Option<DocumentKind>,
    title: Option<String>,
    language: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    source_url: Option<String>,
    revision: Option<String>,
    license: Option<LicenseInfo>,
    example_metadata: Option<ExampleMetadata>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct FetchMetadata {
    fetched_at: Option<String>,
    etag: Option<String>,
    last_modified: Option<String>,
}
struct RawFile {
    path: String,
    identity: String,
    text: String,
    hash: String,
    source_url: Option<String>,
    revision: String,
    metadata: FetchMetadata,
}

pub fn load_manifest(path: &Path) -> Result<SourcesManifest> {
    let text = fs::read_to_string(path).map_err(|e| {
        Error::Config(format!(
            "cannot read sources manifest {}: {e}",
            path.display()
        ))
    })?;
    let manifest: SourcesManifest = toml::from_str(&text)
        .map_err(|e| Error::Config(format!("invalid sources manifest: {e}")))?;
    let mut ids = BTreeSet::new();
    for source in &manifest.sources {
        validate_id(&source.source_id)?;
        if !ids.insert(source.source_id.clone()) {
            return Err(Error::Config(format!(
                "duplicate source_id {}",
                source.source_id
            )));
        }
        match (source.source_type.as_str(), source.extractor.as_str()) {
            ("strudel_repository", "strudel_mdx" | "strudel_jsdoc")
            | ("html_pages", "pressbooks")
            | ("local_directory", "auto" | "strudel_mdx" | "strudel_jsdoc" | "pressbooks") => {}
            _ => {
                return Err(Error::Config(format!(
                    "unsupported type/extractor for {}",
                    source.source_id
                )));
            }
        }
        for path in source
            .paths
            .iter()
            .chain(&source.reference_paths)
            .chain(&source.evidence_paths)
        {
            safe_relative(path)?;
        }
    }
    Ok(manifest)
}

pub async fn ingest(config: &Config, source_ids: &[String]) -> Result<IngestReport> {
    ingest_with_options(config, source_ids, &IngestOptions::default()).await
}

pub async fn ingest_with_options(
    config: &Config,
    source_ids: &[String],
    options: &IngestOptions,
) -> Result<IngestReport> {
    if options.local_root.is_some() && (source_ids.len() != 1 || options.examples_dir.is_some()) {
        return Err(Error::InvalidArgument(
            "--local-root requires exactly one --source and cannot accompany --examples-dir".into(),
        ));
    }
    let mut manifest = load_manifest(&config.sources_manifest)?;
    if let Some(root) = &options.examples_dir {
        if source_ids != ["local-examples"] {
            return Err(Error::InvalidArgument(
                "--examples-dir requires --source local-examples".into(),
            ));
        }
        manifest.sources.retain(|s| s.source_id != "local-examples");
        manifest.sources.push(SourceSpec {
            source_id: "local-examples".into(),
            source_type: "local_directory".into(),
            extractor: "auto".into(),
            root: Some(fs::canonicalize(root).map_err(|e| {
                Error::InvalidArgument(format!("cannot open examples directory: {e}"))
            })?),
            paths: vec![],
            urls: vec![],
            reference_paths: vec![],
            evidence_paths: vec![],
            api_names: vec![],
            base_url: None,
            revision: None,
            language: None,
            license: None,
            kind: Some(DocumentKind::Example),
            fixture: false,
        });
    }
    for id in source_ids {
        if !manifest.sources.iter().any(|s| &s.source_id == id) {
            return Err(Error::InvalidArgument(format!("unknown source {id}")));
        }
    }
    let _lock = WriterLock::acquire(&config.data_dir)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("strudel-rag/0.1 local-research-importer")
        .build()
        .map_err(|e| Error::Other(e.to_string()))?;
    let manifest_dir = config.sources_manifest.parent().unwrap_or(Path::new("."));
    let mut reports = Vec::new();
    let mut failures = Vec::new();
    // Publish API snapshots before MDX expands their JsDoc references.
    manifest
        .sources
        .sort_by_key(|spec| spec.extractor != "strudel_jsdoc");
    let api_source_ids: BTreeSet<_> = manifest
        .sources
        .iter()
        .filter(|spec| spec.extractor == "strudel_jsdoc")
        .map(|spec| spec.source_id.as_str())
        .collect();
    for spec in &manifest.sources {
        if !source_ids.is_empty() && !source_ids.contains(&spec.source_id) {
            continue;
        }
        if spec.fixture && !config.allow_fixture {
            failures.push(format!(
                "{}: fixture source requires --allow-fixture",
                spec.source_id
            ));
            continue;
        }
        match ingest_source(
            config,
            spec,
            manifest_dir,
            options.local_root.as_deref(),
            &client,
            &api_source_ids,
        )
        .await
        {
            Ok(snapshot) => {
                let changed = match publish_source(config, &snapshot) {
                    Ok(changed) => changed,
                    Err(error) => { failures.push(format!("{}: snapshot publication failed: {error}", spec.source_id)); continue; }
                };
                reports.push(SourceIngestReport { source_id: spec.source_id.clone(), documents: snapshot.documents.len(), imported: if changed { snapshot.documents.len() } else { 0 }, skipped: if changed { 0 } else { snapshot.documents.len() }, revision: snapshot.revision, raw_hashes: snapshot.raw_hashes, coverage_gaps: snapshot.coverage_gaps, fixture: snapshot.fixture });
            }
            Err(error) => failures.push(format!("{}: {error}; retain the previous snapshot; use ingest --source {} --local-root PATH with an authorized saved source/checkout", spec.source_id, spec.source_id)),
        }
    }
    if !failures.is_empty() {
        let successful = reports
            .iter()
            .map(|r| format!("{} ({} documents)", r.source_id, r.documents))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(Error::Other(format!(
            "source ingestion failed: {}; successful sources: [{}]",
            failures.join("; "),
            successful
        )));
    }
    Ok(IngestReport {
        documents: reports.iter().map(|r| r.documents).sum(),
        imported: reports.iter().map(|r| r.imported).sum(),
        skipped: reports.iter().map(|r| r.skipped).sum(),
        sources: reports,
    })
}

async fn ingest_source(
    config: &Config,
    spec: &SourceSpec,
    manifest_dir: &Path,
    local_override: Option<&Path>,
    client: &reqwest::Client,
    api_source_ids: &BTreeSet<&str>,
) -> Result<SourceSnapshot> {
    let root = local_override.map(Path::to_path_buf).or_else(|| {
        spec.root.as_ref().map(|p| {
            if p.is_absolute() {
                p.clone()
            } else {
                manifest_dir.join(p)
            }
        })
    });
    let root = root
        .map(|p| {
            fs::canonicalize(&p).map_err(|e| {
                Error::InvalidArgument(format!(
                    "source root must exist and be readable ({}): {e}",
                    p.display()
                ))
            })
        })
        .transpose()?;
    let paths = if spec.source_type == "local_directory" {
        let root = root
            .as_ref()
            .ok_or_else(|| Error::Config("local_directory requires root".into()))?;
        discover_local(root)?
    } else if spec.source_type == "html_pages" {
        spec.urls
            .iter()
            .map(|url| saved_html_path(url))
            .collect::<Result<Vec<_>>>()?
    } else {
        spec.paths.clone()
    };
    if paths.is_empty() {
        return Err(Error::InvalidArgument(
            "source is empty; provide at least one supported file".into(),
        ));
    }
    let selected: Vec<String> = paths
        .iter()
        .chain(&spec.reference_paths)
        .chain(&spec.evidence_paths)
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let git_revision = root
        .as_ref()
        .filter(|_| spec.source_type != "html_pages")
        .map(|r| git_revision(r, &selected, spec.revision.as_deref()))
        .transpose()?
        .flatten();
    let mut raws = BTreeMap::new();
    for path in &selected {
        let url = if spec.source_type == "html_pages" {
            spec.urls
                .iter()
                .find(|u| saved_html_path(u).ok().as_deref() == Some(path.as_str()))
                .cloned()
        } else {
            spec.base_url.as_ref().map(|base| {
                base.replace("{revision}", spec.revision.as_deref().unwrap_or("main"))
                    .replace("{path}", path)
            })
        };
        let raw = if let Some(root) = &root {
            let target = checked_local_path(root, path)?;
            let text = fs::read_to_string(&target)?;
            let hash = sha256(text.as_bytes());
            let revision = git_revision
                .clone()
                .unwrap_or_else(|| format!("sha256:{hash}"));
            let metadata = FetchMetadata::default();
            save_raw(config, spec, &revision, path, &text, &metadata)?;
            RawFile {
                path: path.clone(),
                identity: if spec.source_type == "html_pages" {
                    url.clone().unwrap_or_else(|| path.clone())
                } else {
                    path.clone()
                },
                text,
                hash,
                source_url: url,
                revision,
                metadata,
            }
        } else {
            let url = url.ok_or_else(|| {
                Error::Config(
                    "remote repository source requires base_url; local source requires root".into(),
                )
            })?;
            fetch_raw(config, spec, path, &url, client).await?
        };
        raws.insert(path.clone(), raw);
    }
    let mut gaps = Vec::new();
    let mut wanted: BTreeSet<String> = spec.api_names.iter().cloned().collect();
    for path in &spec.reference_paths {
        let raw = &raws[path];
        wanted.extend(parsers::jsdoc_references(&raw.text));
    }
    let api_sources = if !api_source_ids.is_empty()
        && (spec.extractor == "strudel_mdx"
            || (spec.extractor == "auto" && paths.iter().any(|path| path.ends_with(".mdx"))))
    {
        load_sources(config)?
    } else {
        Vec::new()
    };
    let mut catalog = BTreeMap::new();
    for source in &api_sources {
        if !api_source_ids.contains(source.source_id.as_str()) || source.fixture != spec.fixture {
            continue;
        }
        for document in &source.documents {
            if document.kind != DocumentKind::Api || document.parent_document_id.is_some() {
                continue;
            }
            catalog.entry(document.title.clone()).or_insert(document);
            if let Some(name) = document.title.strip_prefix("Pattern.") {
                catalog.entry(name.to_owned()).or_insert(document);
            }
        }
    }
    let mut documents = Vec::new();
    let mut found = BTreeSet::new();
    for path in &paths {
        let raw = &raws[path];
        let sidecar = if spec.source_type == "local_directory" {
            let root = root.as_ref().expect("validated root");
            let sidecar_path = root.join(format!("{path}.meta.json"));
            if sidecar_path.exists() {
                let checked = checked_local_path(root, &format!("{path}.meta.json"))?;
                serde_json::from_str::<Sidecar>(&fs::read_to_string(checked)?)?
            } else {
                Sidecar::default()
            }
        } else {
            Sidecar::default()
        };
        let revision = sidecar
            .revision
            .clone()
            .or_else(|| {
                if spec.source_type == "local_directory" {
                    spec.revision.clone()
                } else {
                    None
                }
            })
            .unwrap_or_else(|| raw.revision.clone());
        let source = SourceRef {
            source_id: spec.source_id.clone(),
            source_url: sidecar
                .source_url
                .clone()
                .or_else(|| raw.source_url.clone()),
            source_path: Some(raw.path.clone()),
            source_revision: Some(revision),
            license: sidecar.license.clone().or_else(|| spec.license.clone()),
            fetched_at: raw.metadata.fetched_at.clone(),
            etag: raw.metadata.etag.clone(),
            last_modified: raw.metadata.last_modified.clone(),
            notices: if spec.fixture {
                vec!["Original technical fixture, not official documentation; no execution or listening verification.".into()]
            } else {
                vec![]
            },
        };
        let extractor = if spec.extractor == "auto" {
            match Path::new(path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
            {
                "mdx" => "strudel_mdx",
                "html" => "html",
                "js" | "mjs" | "strudel" => "code",
                _ => "markdown",
            }
        } else {
            spec.extractor.as_str()
        };
        let kind = sidecar
            .kind
            .or(spec.kind)
            .unwrap_or(if spec.source_type == "html_pages" {
                DocumentKind::Theory
            } else {
                DocumentKind::Api
            });
        let title = sidecar.title.clone().unwrap_or_else(|| {
            Path::new(path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(path)
                .to_owned()
        });
        let language = sidecar.language.clone().or_else(|| spec.language.clone());
        let base = new_document(spec, raw, source, kind, title, language, &sidecar);
        let extracted = match extractor {
            "strudel_jsdoc" => {
                parsers::extract_jsdoc(&raw.text, &base, &wanted, &mut found, &mut gaps)?
            }
            "strudel_mdx" => parsers::extract_mdx(&raw.text, base, &catalog, &mut gaps)?,
            "pressbooks" => parsers::extract_html(&raw.text, base, true, &mut gaps)?,
            "html" => parsers::extract_html(&raw.text, base, false, &mut gaps)?,
            "code" => parsers::extract_code(&raw.text, base),
            "markdown" => parsers::extract_markdown(&raw.text, base, &mut gaps),
            _ => return Err(Error::Config(format!("unsupported extractor {extractor}"))),
        };
        documents.extend(extracted);
    }
    if spec.extractor == "strudel_jsdoc" {
        for name in wanted {
            if !found.contains(&name)
                && !found.contains(name.strip_prefix("Pattern.").unwrap_or(&name))
            {
                gaps.push(format!("unresolved JSDoc name: {name}"));
            }
        }
    }
    if documents.is_empty() {
        return Err(Error::Other(
            "no retrieval documents were extracted; inspect source paths/extractors".into(),
        ));
    }
    documents.sort_by(|a, b| a.document_id.cmp(&b.document_id));
    let mut ids = BTreeSet::new();
    for d in &documents {
        if !ids.insert(&d.document_id) {
            return Err(Error::Corrupt(
                "duplicate document identity in source extraction".into(),
            ));
        }
    }
    let raw_hashes = raws
        .iter()
        .map(|(p, r)| (p.clone(), r.hash.clone()))
        .collect();
    let revisions: BTreeSet<_> = raws.values().map(|r| r.revision.clone()).collect();
    let revision = if revisions.len() == 1 {
        revisions.into_iter().next()
    } else {
        Some(format!(
            "sha256:{}",
            sha256(serde_json::to_vec(&raw_hashes)?)
        ))
    };
    Ok(SourceSnapshot {
        source_id: spec.source_id.clone(),
        revision,
        documents,
        fixture: spec.fixture,
        coverage_gaps: gaps,
        raw_hashes,
    })
}

fn new_document(
    spec: &SourceSpec,
    raw: &RawFile,
    source: SourceRef,
    kind: DocumentKind,
    title: String,
    language: Option<String>,
    sidecar: &Sidecar,
) -> Document {
    Document {
        document_id: document_id(&spec.source_id, &raw.identity, ""),
        kind,
        title,
        heading_path: vec![],
        source,
        language,
        content: String::new(),
        code_blocks: vec![],
        tags: sidecar.tags.clone(),
        parent_document_id: None,
        content_hash: String::new(),
        verification_status: VerificationStatus::SourceOnly,
        verification_evidence: None,
        example_metadata: sidecar.example_metadata.clone(),
    }
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(Error::Config(
            "source_id must contain only ASCII letters, digits, hyphens or underscores".into(),
        ));
    }
    Ok(())
}
fn safe_relative(path: &str) -> Result<()> {
    if path.is_empty()
        || path.contains('\\')
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(Error::Config(format!(
            "source path must be a relative POSIX path without traversal: {path}"
        )));
    }
    Ok(())
}
fn checked_local_path(root: &Path, path: &str) -> Result<PathBuf> {
    safe_relative(path)?;
    let target = fs::canonicalize(root.join(path))?;
    if !target.starts_with(root) {
        return Err(Error::InvalidArgument(
            "source symlink escapes the configured root".into(),
        ));
    }
    if !target.is_file() {
        return Err(Error::InvalidArgument(format!(
            "source path is not a file: {path}"
        )));
    }
    Ok(target)
}
fn discover_local(root: &Path) -> Result<Vec<String>> {
    if !root.is_dir() {
        return Err(Error::InvalidArgument(
            "source root must be a directory".into(),
        ));
    }
    let mut files = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry =
            entry.map_err(|e| Error::Other(format!("cannot enumerate local source: {e}")))?;
        if entry.file_type().is_symlink() && !fs::canonicalize(entry.path())?.starts_with(root) {
            return Err(Error::InvalidArgument(
                "source symlink escapes the configured root".into(),
            ));
        }
        if !entry.path().is_file() {
            continue;
        }
        if matches!(
            entry.path().extension().and_then(|s| s.to_str()),
            Some("md" | "mdx" | "html" | "js" | "mjs" | "strudel")
        ) {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|e| Error::Other(e.to_string()))?
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            files.push(relative);
        }
    }
    files.sort();
    Ok(files)
}
fn saved_html_path(url: &str) -> Result<String> {
    let parsed =
        url::Url::parse(url).map_err(|e| Error::Config(format!("invalid source URL: {e}")))?;
    let slug = parsed
        .path_segments()
        .and_then(|mut segments| segments.rfind(|s| !s.is_empty()))
        .ok_or_else(|| Error::Config("chapter URL needs a slug".into()))?;
    let path = format!("{slug}.html");
    safe_relative(&path)?;
    Ok(path)
}
fn git_revision(root: &Path, paths: &[String], expected: Option<&str>) -> Result<Option<String>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--verify", "HEAD"])
        .output();
    let Ok(output) = output else {
        return Ok(None);
    };
    if !output.status.success() {
        return Ok(None);
    }
    let head = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain", "--untracked-files=all", "--"])
        .args(paths);
    let status = command.output()?;
    if !status.status.success() {
        return Err(Error::Other(
            "unable to check selected checkout files for changes".into(),
        ));
    }
    if !status.stdout.is_empty() {
        let mut selected = BTreeMap::new();
        for path in paths {
            selected.insert(path, sha256(fs::read(checked_local_path(root, path)?)?));
        }
        return Ok(Some(format!(
            "git:{head}+content:{}",
            sha256(serde_json::to_vec(&selected)?)
        )));
    }
    if expected.is_some_and(|revision| revision != head) {
        return Err(Error::InvalidArgument(format!(
            "clean checkout HEAD {head} does not match manifest revision {}; checkout the pinned revision",
            expected.unwrap_or_default()
        )));
    }
    Ok(Some(head))
}

fn revision_directory(revision: &str) -> String {
    if revision
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        revision.into()
    } else {
        sha256(revision.as_bytes())
    }
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| Error::Other("raw destination has no parent".into()))?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|e| Error::Io(e.error))?;
    Ok(())
}
fn save_raw(
    config: &Config,
    spec: &SourceSpec,
    revision: &str,
    path: &str,
    text: &str,
    metadata: &FetchMetadata,
) -> Result<()> {
    safe_relative(path)?;
    let target = config
        .data_dir
        .join("raw")
        .join(&spec.source_id)
        .join(revision_directory(revision))
        .join(path);
    if !target.exists() || sha256(fs::read(&target)?) != sha256(text.as_bytes()) {
        atomic_write(&target, text.as_bytes())?;
    }
    let meta_path = target.with_file_name(format!(
        "{}.fetch.json",
        target.file_name().unwrap_or_default().to_string_lossy()
    ));
    atomic_write(&meta_path, &serde_json::to_vec(metadata)?)
}
async fn fetch_raw(
    config: &Config,
    spec: &SourceSpec,
    path: &str,
    url: &str,
    client: &reqwest::Client,
) -> Result<RawFile> {
    let parsed = url::Url::parse(url).map_err(|e| Error::Config(e.to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(Error::Config("source URLs must use HTTP or HTTPS".into()));
    }
    if spec.source_type == "strudel_repository"
        && let Some(revision) = &spec.revision
    {
        let cached = config
            .data_dir
            .join("raw")
            .join(&spec.source_id)
            .join(revision_directory(revision))
            .join(path);
        if cached.is_file() {
            let text = fs::read_to_string(&cached)?;
            let metadata_path = cached.with_file_name(format!(
                "{}.fetch.json",
                cached.file_name().unwrap_or_default().to_string_lossy()
            ));
            let metadata = if metadata_path.is_file() {
                serde_json::from_slice(&fs::read(metadata_path)?)?
            } else {
                FetchMetadata::default()
            };
            return Ok(RawFile {
                path: path.into(),
                identity: path.into(),
                hash: sha256(text.as_bytes()),
                text,
                source_url: Some(url.into()),
                revision: revision.clone(),
                metadata,
            });
        }
    }
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| Error::Other(format!("source download transport error: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(Error::Other(format!(
            "source download HTTP {status}; access restrictions are not bypassed"
        )));
    }
    let metadata = FetchMetadata {
        fetched_at: Some(
            OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .map_err(|e| Error::Other(e.to_string()))?,
        ),
        etag: response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
        last_modified: response
            .headers()
            .get(reqwest::header::LAST_MODIFIED)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
    };
    let bytes = response
        .bytes()
        .await
        .map_err(|e| Error::Other(format!("cannot read source response: {e}")))?;
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|e| Error::Other(format!("source must be UTF-8: {e}")))?;
    let hash = sha256(text.as_bytes());
    let revision = if spec.source_type == "strudel_repository" {
        spec.revision
            .clone()
            .ok_or_else(|| Error::Config("repository source must pin a revision".into()))?
    } else {
        format!("sha256:{hash}")
    };
    save_raw(config, spec, &revision, path, &text, &metadata)?;
    Ok(RawFile {
        path: path.into(),
        identity: if spec.source_type == "html_pages" {
            url.into()
        } else {
            path.into()
        },
        text,
        hash,
        source_url: Some(url.into()),
        revision,
        metadata,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{chunk_document, store::load_sources};

    fn local_config(temporary: &tempfile::TempDir) -> Config {
        let root = temporary.path().join("source");
        fs::create_dir_all(&root).unwrap();
        let manifest = temporary.path().join("sources.toml");
        fs::write(&manifest, format!("[[sources]]\nsource_id = \"local\"\ntype = \"local_directory\"\nextractor = \"auto\"\nroot = {:?}\nkind = \"api\"\n", root.to_string_lossy())).unwrap();
        Config {
            data_dir: temporary.path().join("data"),
            sources_manifest: manifest,
            ..Config::default()
        }
    }
    #[tokio::test]
    async fn repeated_ingest_is_stable_metadata_updates_and_failed_parse_preserves_snapshot() {
        let temporary = tempfile::tempdir().unwrap();
        let config = local_config(&temporary);
        let source = temporary.path().join("source/example.md");
        fs::write(
            &source,
            "# Slow\n\nStretch a pattern.\n\n```javascript\ns(\"bd\").slow(2)\n```\n",
        )
        .unwrap();
        let first = ingest(&config, &[]).await.unwrap();
        assert!(first.imported > 0);
        let before = load_sources(&config).unwrap().remove(0);
        let before_ids = before
            .documents
            .iter()
            .map(|d| &d.document_id)
            .collect::<Vec<_>>();
        let second = ingest(&config, &[]).await.unwrap();
        assert_eq!(second.imported, 0);
        assert_eq!(second.skipped, first.imported);
        let unchanged = load_sources(&config).unwrap().remove(0);
        assert_eq!(
            before_ids,
            unchanged
                .documents
                .iter()
                .map(|d| &d.document_id)
                .collect::<Vec<_>>()
        );
        let original = before
            .documents
            .iter()
            .find(|d| d.parent_document_id.is_none())
            .unwrap();
        let old_chunks = chunk_document(original, &config.chunking).unwrap();
        fs::write(
            source.with_file_name("example.md.meta.json"),
            r#"{"revision":"declared-revision","tags":["changed"]}"#,
        )
        .unwrap();
        ingest(&config, &[]).await.unwrap();
        let revised = load_sources(&config).unwrap().remove(0);
        assert_eq!(
            before_ids,
            revised
                .documents
                .iter()
                .map(|d| &d.document_id)
                .collect::<Vec<_>>()
        );
        assert!(
            revised
                .documents
                .iter()
                .all(|d| d.source.source_revision.as_deref() == Some("declared-revision"))
        );
        fs::write(&source, "# Slow\n\nChanged content.\n").unwrap();
        ingest(&config, &[]).await.unwrap();
        let changed = load_sources(&config).unwrap().remove(0);
        assert_eq!(changed.documents[0].document_id, original.document_id);
        let new_chunks = chunk_document(&changed.documents[0], &config.chunking).unwrap();
        assert_ne!(old_chunks[0].chunk_id, new_chunks[0].chunk_id);
        fs::write(source.with_file_name("example.md.meta.json"), "{bad json").unwrap();
        assert!(ingest(&config, &[]).await.is_err());
        assert_eq!(
            load_sources(&config).unwrap()[0].documents,
            changed.documents
        );
    }
    #[tokio::test]
    async fn saved_html_revisions_follow_content_not_the_surrounding_repository() {
        let temporary = tempfile::tempdir().unwrap();
        for args in [
            vec!["init", "--quiet"],
            vec![
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.org",
                "commit",
                "--quiet",
                "--allow-empty",
                "--no-gpg-sign",
                "-m",
                "Fixture",
            ],
        ] {
            assert!(
                Command::new("git")
                    .current_dir(temporary.path())
                    .args(args)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let root = temporary.path().join("saved");
        fs::create_dir(&root).unwrap();
        let config = Config {
            data_dir: temporary.path().join("data"),
            sources_manifest: temporary.path().join("sources.toml"),
            ..Config::default()
        };
        fs::write(
            &config.sources_manifest,
            "[[sources]]\nsource_id = \"theory\"\ntype = \"html_pages\"\nextractor = \"pressbooks\"\nroot = \"saved\"\nurls = [\"https://example.org/chapter/harmony/\"]\n",
        )
        .unwrap();
        let expected_id = document_id("theory", "https://example.org/chapter/harmony/", "");
        for text in [
            "<section data-type=\"chapter\"><h1>Harmony</h1><p>Tonic.</p></section>",
            "<section data-type=\"chapter\"><h1>Harmony</h1><p>Dominant.</p></section>",
        ] {
            fs::write(root.join("harmony.html"), text).unwrap();
            ingest(&config, &[]).await.unwrap();
            let source = load_sources(&config).unwrap().remove(0);
            let revision = format!("sha256:{}", sha256(text));
            assert_eq!(source.revision.as_deref(), Some(revision.as_str()));
            assert_eq!(source.documents[0].document_id, expected_id);
            assert_eq!(
                source.documents[0].source.source_revision.as_deref(),
                Some(revision.as_str())
            );
        }
    }
    #[tokio::test]
    async fn traversal_empty_and_missing_sources_are_actionable_errors() {
        assert!(safe_relative("../secret.md").is_err());
        assert!(safe_relative("/absolute.md").is_err());
        assert!(safe_relative("nested/file.md").is_ok());
        let temporary = tempfile::tempdir().unwrap();
        let config = local_config(&temporary);
        assert!(
            ingest(&config, &[])
                .await
                .unwrap_err()
                .to_string()
                .contains("empty")
        );
        assert!(
            ingest(&config, &["unknown".into()])
                .await
                .unwrap_err()
                .to_string()
                .contains("unknown source")
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn outside_symlinks_cannot_escape_local_root() {
        let temporary = tempfile::tempdir().unwrap();
        let config = local_config(&temporary);
        let outside = temporary.path().join("outside.md");
        fs::write(&outside, "secret").unwrap();
        std::os::unix::fs::symlink(outside, temporary.path().join("source/escape.md")).unwrap();
        assert!(
            ingest(&config, &[])
                .await
                .unwrap_err()
                .to_string()
                .contains("escapes")
        );
    }
}
