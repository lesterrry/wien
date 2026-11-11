use crate::{Config, Document, Error, Result, SourceSnapshot, sha256};
use fs2::FileExt;
use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

pub struct WriterLock(File);
impl WriterLock {
    pub fn acquire(data_dir: &Path) -> Result<Self> {
        fs::create_dir_all(data_dir)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(data_dir.join("writer.lock"))?;
        file.lock_exclusive()?;
        Ok(Self(file))
    }
}
impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::Other("destination has no parent".into()))?;
    fs::create_dir_all(parent)?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| Error::Io(e.error))?;
    File::open(parent)?.sync_all()?;
    Ok(())
}
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    Ok(serde_json::from_reader(File::open(path)?)?)
}
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    atomic_write(path, &serde_json::to_vec(value)?)
}
pub fn read_jsonl<T: DeserializeOwned>(path: &Path) -> Result<Vec<T>> {
    let mut result = Vec::new();
    for line in BufReader::new(File::open(path)?).lines() {
        let line = line?;
        if !line.trim().is_empty() {
            result.push(serde_json::from_str(&line)?);
        }
    }
    Ok(result)
}
pub fn write_jsonl<T: Serialize>(path: &Path, values: &[T]) -> Result<()> {
    let mut bytes = Vec::new();
    for value in values {
        serde_json::to_writer(&mut bytes, value)?;
        bytes.push(b'\n');
    }
    atomic_write(path, &bytes)
}
pub fn validate_component(s: &str) -> Result<()> {
    if s.is_empty()
        || s == "."
        || s == ".."
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:+".contains(&b))
    {
        return Err(Error::InvalidArgument("unsafe storage identity".into()));
    }
    Ok(())
}
pub fn current_dir(root: &Path) -> Result<Option<PathBuf>> {
    let p = root.join("CURRENT");
    if !p.exists() {
        return Ok(None);
    }
    let id = fs::read_to_string(p)?;
    let id = id.trim();
    validate_component(id)?;
    let candidate = root.join(id);
    if !candidate.is_dir() {
        return Err(Error::Corrupt("CURRENT references absent snapshot".into()));
    }
    Ok(Some(candidate))
}
/// The caller must hold the shared WriterLock when publishing sources.
pub fn publish_source(config: &Config, snapshot: &SourceSnapshot) -> Result<bool> {
    validate_component(&snapshot.source_id)?;
    if snapshot
        .documents
        .iter()
        .any(|d| d.source.source_id != snapshot.source_id)
    {
        return Err(Error::Corrupt("snapshot source identity mismatch".into()));
    }
    let mut sorted = snapshot.clone();
    sorted
        .documents
        .sort_by(|a, b| a.document_id.cmp(&b.document_id));
    let digest = sha256(serde_json::to_vec(&sorted)?);
    let root = config.data_dir.join("normalized").join(&snapshot.source_id);
    let snapshots = root.join("snapshots");
    fs::create_dir_all(&snapshots)?;
    if fs::read_to_string(root.join("CURRENT")).ok().as_deref() == Some(digest.as_str()) {
        return Ok(false);
    }
    let target = snapshots.join(&digest);
    if !target.exists() {
        let temp = tempfile::Builder::new()
            .prefix(".snapshot-")
            .tempdir_in(&snapshots)?;
        write_jsonl(&temp.path().join("documents.jsonl"), &sorted.documents)?;
        let mut meta = sorted.clone();
        meta.documents.clear();
        write_json(&temp.path().join("source.json"), &meta)?;
        let check: Vec<Document> = read_jsonl(&temp.path().join("documents.jsonl"))?;
        if check != sorted.documents {
            return Err(Error::Corrupt("snapshot validation failed".into()));
        }
        fs::rename(temp.path(), &target)?;
    }
    atomic_write(&root.join("CURRENT"), digest.as_bytes())?;
    Ok(true)
}
pub fn load_sources(config: &Config) -> Result<Vec<SourceSnapshot>> {
    let root = config.data_dir.join("normalized");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut entries = fs::read_dir(root)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|e| e.file_name());
    let mut result = Vec::new();
    for entry in entries {
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let base = entry.path();
        let pointer = base.join("CURRENT");
        if !pointer.exists() {
            continue;
        }
        let id = fs::read_to_string(pointer)?;
        validate_component(id.trim())?;
        let dir = base.join("snapshots").join(id.trim());
        let mut source: SourceSnapshot = read_json(&dir.join("source.json"))?;
        source.documents = read_jsonl(&dir.join("documents.jsonl"))?;
        if source
            .documents
            .iter()
            .any(|d| d.source.source_id != source.source_id)
        {
            return Err(Error::Corrupt("source snapshot metadata mismatch".into()));
        }
        result.push(source);
    }
    Ok(result)
}
