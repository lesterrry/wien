use crate::*;
use async_trait::async_trait;
use std::{
    cmp::{Ordering, Reverse},
    collections::{BinaryHeap, HashMap, HashSet},
    sync::Arc,
};
use tantivy::{
    Term,
    collector::TopDocs,
    query::{BooleanQuery, BoostQuery, Occur, Query, TermQuery},
    schema::{IndexRecordOption, Value},
    tokenizer::{SimpleTokenizer, TokenStream, Tokenizer},
};
#[async_trait]
pub trait Reranker: Send + Sync {
    async fn rerank(&self, query: &str, candidates: &[SearchHit]) -> Result<Vec<usize>>;
}
struct ReadyState {
    snapshot: IndexSnapshot,
    reader: tantivy::IndexReader,
    documents: HashMap<String, usize>,
    chunks: HashMap<String, usize>,
}
pub struct RagEngine {
    config: Config,
    provider: Arc<dyn EmbeddingProvider>,
    state: Option<Arc<ReadyState>>,
    reason: Option<String>,
    reranker: Option<Arc<dyn Reranker>>,
}
impl RagEngine {
    pub fn open(config: &Config, provider: Arc<dyn EmbeddingProvider>) -> Result<Self> {
        config.validate()?;
        let loaded = (|| {
            let snapshot = open_index(config)?.ok_or_else(|| {
                Error::NotReady("no index generation; run ingest then index".into())
            })?;
            if snapshot.manifest.fingerprint != provider.identity().fingerprint() {
                return Err(Error::NotReady(
                    "embedding identity differs from index; rebuild required".into(),
                ));
            }
            if config.embedding.provider == "mock"
                && (!config.allow_fixture || !snapshot.manifest.fixture)
            {
                return Err(Error::Config(
                    "mock retrieval requires an explicitly allowed fixture corpus".into(),
                ));
            }
            let reader = snapshot.lexical.reader()?;
            let documents = snapshot
                .documents
                .iter()
                .enumerate()
                .map(|(i, d)| (d.document_id.clone(), i))
                .collect();
            let chunks = snapshot
                .chunks
                .iter()
                .enumerate()
                .map(|(i, c)| (c.chunk_id.clone(), i))
                .collect();
            Ok(ReadyState {
                snapshot,
                reader,
                documents,
                chunks,
            })
        })();
        let (state,reason)=match loaded{Ok(state)=>(Some(Arc::new(state)),None),Err(Error::Config(e))=>return Err(Error::Config(e)),Err(Error::NotReady(e))=>(None,Some(e)),Err(_)=>(None,Some("index generation is unreadable, corrupt or incompatible; run doctor and rebuild".into()))};
        Ok(Self {
            config: config.clone(),
            provider,
            state,
            reason,
            reranker: None,
        })
    }
    pub fn with_reranker(mut self, reranker: Arc<dyn Reranker>) -> Self {
        self.reranker = Some(reranker);
        self
    }
    pub fn corpus_info(&self) -> CorpusInfo {
        let Some(s) = &self.state else {
            return CorpusInfo {
                readiness_reason: self.reason.clone(),
                ..Default::default()
            };
        };
        let m = &s.snapshot.manifest;
        CorpusInfo {
            ready: true,
            readiness_reason: None,
            documents: m.documents,
            chunks: m.chunks,
            counts_by_kind: [
                DocumentKind::Api,
                DocumentKind::Theory,
                DocumentKind::Example,
            ]
            .into_iter()
            .map(|kind| KindCount {
                kind,
                documents: s
                    .snapshot
                    .documents
                    .iter()
                    .filter(|d| d.kind == kind)
                    .count(),
                chunks: s.snapshot.chunks.iter().filter(|c| c.kind == kind).count(),
            })
            .collect(),
            sources: m.sources.clone(),
            model: Some(m.model.clone()),
            dimension: Some(m.dimension),
            fingerprint: Some(m.fingerprint.clone()),
            index_version: Some(m.generation.clone()),
            built_at: Some(m.built_at.clone()),
            fixture: m.fixture,
        }
    }
    pub fn get_document(
        &self,
        reference: DocumentReference,
        parent: bool,
    ) -> Result<DocumentResponse> {
        let s = self
            .state
            .as_ref()
            .ok_or_else(|| Error::NotReady(self.reason.clone().unwrap_or_default()))?;
        let record = match reference {
            DocumentReference::DocumentId(id) => {
                if id.is_empty() {
                    return Err(Error::InvalidArgument("document ID is empty".into()));
                }
                let d = s
                    .documents
                    .get(&id)
                    .map(|&i| &s.snapshot.documents[i])
                    .ok_or_else(|| Error::NotFound("document ID".into()))?;
                if parent {
                    let id = d.parent_document_id.as_ref().unwrap_or(&d.document_id);
                    Record::from(
                        s.documents
                            .get(id)
                            .map(|&i| &s.snapshot.documents[i])
                            .ok_or_else(|| Error::Corrupt("missing parent document".into()))?,
                    )
                } else {
                    Record::from(d)
                }
            }
            DocumentReference::ChunkId(id) => {
                if id.is_empty() {
                    return Err(Error::InvalidArgument("chunk ID is empty".into()));
                }
                let c = s
                    .chunks
                    .get(&id)
                    .map(|&i| &s.snapshot.chunks[i])
                    .ok_or_else(|| Error::NotFound("chunk ID".into()))?;
                if parent {
                    let id = c.parent_document_id.as_ref().unwrap_or(&c.document_id);
                    Record::from(
                        s.documents
                            .get(id)
                            .map(|&i| &s.snapshot.documents[i])
                            .ok_or_else(|| Error::Corrupt("missing parent document".into()))?,
                    )
                } else {
                    Record::from(c)
                }
            }
        };
        Ok(DocumentResponse {
            record,
            index_version: s.snapshot.manifest.generation.clone(),
        })
    }
    pub async fn search(&self, request: SearchRequest) -> Result<SearchResponse> {
        if request.query.trim().is_empty() || request.query.len() > 4096 {
            return Err(Error::InvalidArgument(
                "query must contain non-whitespace and at most 4096 UTF-8 bytes".into(),
            ));
        }
        let top = request.top_k.unwrap_or(self.config.retrieval.top_k);
        if top == 0 || top > self.config.retrieval.max_top_k {
            return Err(Error::InvalidArgument(format!(
                "top_k must be 1..{}",
                self.config.retrieval.max_top_k
            )));
        }
        let state = self
            .state
            .clone()
            .ok_or_else(|| Error::NotReady(self.reason.clone().unwrap_or_default()))?;
        let intent_kind = match request.intent {
            SearchIntent::Api => Some(DocumentKind::Api),
            SearchIntent::Musical => Some(DocumentKind::Theory),
            SearchIntent::Example => Some(DocumentKind::Example),
            SearchIntent::Mixed => None,
        };
        if intent_kind.is_some_and(|k| {
            !request.filters.kinds.is_empty() && !request.filters.kinds.contains(&k)
        }) {
            let m = &state.snapshot.manifest;
            return Ok(SearchResponse {
                results: Vec::new(),
                diagnostics: SearchDiagnostics {
                    generation: m.generation.clone(),
                    model: m.model.clone(),
                    dimension: m.dimension,
                    lexical_candidates: 0,
                    vector_candidates: 0,
                    diversity_applied: false,
                    fixture: m.fixture,
                    scores_are_probabilities: false,
                },
            });
        }
        let batch = self
            .provider
            .embed(std::slice::from_ref(&request.query))
            .await?;
        if batch.model != state.snapshot.manifest.model || batch.vectors.len() != 1 {
            return Err(Error::NotReady(
                "query embedding model/count incompatible with index".into(),
            ));
        }
        let mut vector = batch
            .vectors
            .into_iter()
            .next()
            .expect("one vector checked");
        normalize_vector(&mut vector, Some(state.snapshot.manifest.dimension)).map_err(|_| {
            Error::NotReady("query embedding dimension incompatible with index".into())
        })?;
        let config = self.config.retrieval.clone();
        let query = request.query.clone();
        let mut response = tokio::task::spawn_blocking(move || {
            search_sync(&state, &request, &config, &vector, top)
        })
        .await
        .map_err(|_| Error::Other("retrieval worker failed".into()))??;
        if let Some(reranker) = &self.reranker {
            let order = reranker.rerank(&query, &response.results).await?;
            let unique = order.iter().copied().collect::<HashSet<_>>();
            if order.len() != response.results.len()
                || unique.len() != order.len()
                || order.iter().any(|&i| i >= order.len())
            {
                return Err(Error::Other(
                    "reranker must return a complete permutation".into(),
                ));
            }
            let mut original = response.results.into_iter().map(Some).collect::<Vec<_>>();
            response.results = order
                .into_iter()
                .map(|i| original[i].take().expect("permutation checked"))
                .collect();
        }
        Ok(response)
    }
}
fn allowed(c: &Chunk, r: &SearchRequest) -> bool {
    let intent = match r.intent {
        SearchIntent::Api => Some(DocumentKind::Api),
        SearchIntent::Musical => Some(DocumentKind::Theory),
        SearchIntent::Example => Some(DocumentKind::Example),
        SearchIntent::Mixed => None,
    };
    intent.is_none_or(|k| c.kind == k)
        && (r.filters.kinds.is_empty() || r.filters.kinds.contains(&c.kind))
        && (r.filters.source_ids.is_empty() || r.filters.source_ids.contains(&c.source.source_id))
        && r.filters.tags.iter().all(|t| c.tags.contains(t))
        && (r.filters.languages.is_empty()
            || c.language
                .as_ref()
                .is_some_and(|l| r.filters.languages.contains(l)))
}
#[derive(Clone, Copy, Debug)]
struct Candidate {
    score: f32,
    index: usize,
}
impl PartialEq for Candidate {
    fn eq(&self, o: &Self) -> bool {
        self.score.to_bits() == o.score.to_bits() && self.index == o.index
    }
}
impl Eq for Candidate {}
impl PartialOrd for Candidate {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Candidate {
    fn cmp(&self, o: &Self) -> Ordering {
        self.score
            .total_cmp(&o.score)
            .then_with(|| o.index.cmp(&self.index))
    }
}
pub fn rrf_score(lexical_rank: Option<usize>, vector_rank: Option<usize>, k: f64) -> f64 {
    lexical_rank
        .into_iter()
        .chain(vector_rank)
        .map(|r| 1.0 / (k + r as f64))
        .sum()
}
fn search_sync(
    state: &ReadyState,
    request: &SearchRequest,
    config: &RetrievalConfig,
    vector: &[f32],
    top: usize,
) -> Result<SearchResponse> {
    let s = &state.snapshot;
    let budget = config.candidate_k.max(top);
    let eligible = s
        .chunks
        .iter()
        .enumerate()
        .filter_map(|(i, c)| allowed(c, request).then_some(i))
        .collect::<Vec<_>>();
    let mut heap: BinaryHeap<Reverse<Candidate>> = BinaryHeap::with_capacity(budget + 1);
    for &i in &eligible {
        let score = s.vectors[i]
            .iter()
            .zip(vector)
            .map(|(a, b)| a * b)
            .sum::<f32>();
        if score < config.min_cosine {
            continue;
        }
        heap.push(Reverse(Candidate { score, index: i }));
        if heap.len() > budget {
            heap.pop();
        }
    }
    let mut vectors = heap.into_iter().map(|r| r.0).collect::<Vec<_>>();
    vectors.sort_by(|a, b| b.cmp(a));
    let schema = s.lexical.schema();
    let field = |name: &str| {
        schema
            .get_field(name)
            .map_err(|e| Error::Corrupt(e.to_string()))
    };
    let id_field = field("chunk_id")?;
    let mut tokenizer = SimpleTokenizer::default();
    let mut stream = tokenizer.token_stream(&request.query);
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    while stream.advance() {
        let text = stream.token().text.to_lowercase();
        if !seen.insert(text.clone()) {
            continue;
        }
        for (name, boost) in [("title", 3.0), ("heading_path", 2.0), ("content", 1.0)] {
            terms.push((
                Occur::Should,
                Box::new(BoostQuery::new(
                    Box::new(TermQuery::new(
                        Term::from_field_text(field(name)?, &text),
                        IndexRecordOption::WithFreqs,
                    )),
                    boost,
                )) as Box<dyn Query>,
            ));
        }
    }
    let mut lexical = Vec::new();
    if !eligible.is_empty() && !terms.is_empty() {
        let filter = BooleanQuery::new(
            eligible
                .iter()
                .map(|&i| {
                    (
                        Occur::Should,
                        Box::new(TermQuery::new(
                            Term::from_field_text(id_field, &s.chunks[i].chunk_id),
                            IndexRecordOption::Basic,
                        )) as Box<dyn Query>,
                    )
                })
                .collect(),
        );
        let query = BooleanQuery::new(vec![
            (
                Occur::Must,
                Box::new(BooleanQuery::new(terms)) as Box<dyn Query>,
            ),
            (
                Occur::Must,
                Box::new(BoostQuery::new(Box::new(filter), 0.0)),
            ),
        ]);
        let searcher = state.reader.searcher();
        for (score, address) in searcher.search(&query, &TopDocs::with_limit(budget))? {
            if score <= 0.0 {
                continue;
            }
            let doc: tantivy::TantivyDocument = searcher.doc(address)?;
            let id = doc
                .get_first(id_field)
                .and_then(|v| v.as_str())
                .ok_or_else(|| Error::Corrupt("lexical document has no chunk ID".into()))?;
            let index = *state
                .chunks
                .get(id)
                .ok_or_else(|| Error::Corrupt("lexical chunk is unknown".into()))?;
            lexical.push((index, score));
        }
    }
    let mut hits: HashMap<usize, SearchHit> = HashMap::new();
    for (rank, &(i, score)) in lexical.iter().enumerate() {
        let hit = hits.entry(i).or_insert_with(|| new_hit(&s.chunks[i]));
        hit.lexical_rank = Some(rank + 1);
        hit.lexical_score = Some(score);
    }
    for (rank, c) in vectors.iter().enumerate() {
        let hit = hits
            .entry(c.index)
            .or_insert_with(|| new_hit(&s.chunks[c.index]));
        hit.vector_rank = Some(rank + 1);
        hit.vector_score = Some(c.score);
    }
    let mut hits = hits.into_values().collect::<Vec<_>>();
    for h in &mut hits {
        h.fusion_score = rrf_score(h.lexical_rank, h.vector_rank, config.rrf_k)
    }
    hits.sort_by(hit_order);
    let mut dedup: HashMap<(DocumentKind, String), usize> = HashMap::new();
    let mut unique: Vec<SearchHit> = Vec::new();
    for hit in hits {
        let key = (hit.record.kind, hit.record.content_hash.clone());
        if let Some(&i) = dedup.get(&key) {
            let source = hit.record.source;
            if source != unique[i].record.source && !unique[i].alternate_sources.contains(&source) {
                unique[i].alternate_sources.push(source)
            }
        } else {
            dedup.insert(key, unique.len());
            unique.push(hit)
        }
    }
    let mut results = Vec::new();
    let mut represented = HashSet::new();
    let mut diversity = false;
    while !unique.is_empty() && results.len() < top {
        let mut pick = 0;
        if request.intent == SearchIntent::Mixed {
            let threshold = unique[0].fusion_score * 0.9;
            if let Some(i) = unique
                .iter()
                .position(|h| h.fusion_score >= threshold && !represented.contains(&h.record.kind))
            {
                pick = i;
                diversity |= i != 0;
            }
        }
        let hit = unique.remove(pick);
        represented.insert(hit.record.kind);
        results.push(hit);
    }
    Ok(SearchResponse {
        results,
        diagnostics: SearchDiagnostics {
            generation: s.manifest.generation.clone(),
            model: s.manifest.model.clone(),
            dimension: s.manifest.dimension,
            lexical_candidates: lexical.len(),
            vector_candidates: vectors.len(),
            diversity_applied: diversity,
            fixture: s.manifest.fixture,
            scores_are_probabilities: false,
        },
    })
}
fn hit_order(a: &SearchHit, b: &SearchHit) -> Ordering {
    b.fusion_score
        .total_cmp(&a.fusion_score)
        .then_with(|| a.record.chunk_id.cmp(&b.record.chunk_id))
}
fn new_hit(c: &Chunk) -> SearchHit {
    SearchHit {
        record: Record::from(c),
        lexical_rank: None,
        lexical_score: None,
        vector_rank: None,
        vector_score: None,
        fusion_score: 0.0,
        alternate_sources: Vec::new(),
    }
}
