use crate::{
    Chunk, ChunkConfig, CodeBlock, Document, DocumentKind, Result, chunk_id, content_hash,
};
use pulldown_cmark::{CodeBlockKind, Event, Parser, Tag, TagEnd};
use std::collections::HashMap;
pub fn approximate_tokens(text: &str) -> usize {
    text.chars().count().div_ceil(4)
}
pub fn embedding_text(chunk: &Chunk) -> String {
    format!(
        "{}\n{}\n\n{}",
        chunk.title,
        chunk.heading_path.join(" > "),
        chunk.content
    )
}
pub fn code_blocks(content: &str) -> Vec<CodeBlock> {
    let mut result = Vec::new();
    let mut current = None;
    for event in Parser::new(content) {
        match event {
            Event::Start(Tag::CodeBlock(kind)) => {
                current = Some(CodeBlock {
                    language: match kind {
                        CodeBlockKind::Fenced(s) => s.split_whitespace().next().map(str::to_owned),
                        CodeBlockKind::Indented => None,
                    },
                    code: String::new(),
                })
            }
            Event::Text(s) => {
                if let Some(c) = &mut current {
                    c.code.push_str(&s)
                }
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some(c) = current.take() {
                    result.push(c)
                }
            }
            _ => {}
        }
    }
    result
}
pub fn strip_frontmatter(text: &str) -> &str {
    if let Some(rest) = text.strip_prefix("---\n") {
        for (end, _) in rest.match_indices("\n---") {
            let suffix = &rest[end + 4..];
            if suffix.is_empty() {
                return suffix;
            }
            if let Some(body) = suffix.strip_prefix('\n') {
                return body;
            }
        }
    }
    text
}
pub fn chunk_document(document: &Document, config: &ChunkConfig) -> Result<Vec<Chunk>> {
    let normalized = document.content.replace("\r\n", "\n");
    let text = strip_frontmatter(&normalized);
    if text.trim().is_empty() {
        tracing::warn!(document_id=%document.document_id,"empty document skipped");
        return Ok(Vec::new());
    }
    let mut fence: Option<(u8, usize)> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if line.len() - trimmed.len() > 3 {
            continue;
        }
        let Some(marker) = trimmed
            .as_bytes()
            .first()
            .copied()
            .filter(|c| *c == b'`' || *c == b'~')
        else {
            continue;
        };
        let count = trimmed.bytes().take_while(|&b| b == marker).count();
        if count < 3 {
            continue;
        }
        match fence {
            None => fence = Some((marker, count)),
            Some((open, n))
                if open == marker && count >= n && trimmed[count..].trim().is_empty() =>
            {
                fence = None
            }
            _ => {}
        }
    }
    if fence.is_some() {
        tracing::warn!(document_id=%document.document_id,"unclosed Markdown fence retained through end of file");
    }
    let mut ranges: Vec<(std::ops::Range<usize>, Vec<String>)> = Vec::new();
    if document.kind == DocumentKind::Example
        && approximate_tokens(text) <= config.max_tokens_approx
    {
        ranges.push((0..text.len(), document.heading_path.clone()));
    } else {
        let mut depth = 0usize;
        let mut block_start = 0;
        let mut block_is_code = false;
        let mut heading = None;
        let mut heading_text = String::new();
        let mut path = document.heading_path.clone();
        let mut pending: Option<(usize, usize, Vec<String>)> = None;
        for (event, range) in Parser::new(text).into_offset_iter() {
            match &event {
                Event::Start(tag) => {
                    if depth == 0 {
                        block_start = range.start;
                        block_is_code = matches!(tag, Tag::CodeBlock(_));
                    }
                    if let Tag::Heading { level, .. } = tag {
                        heading = Some(*level as usize);
                        heading_text.clear();
                    }
                    depth += 1;
                }
                Event::Text(t) | Event::Code(t) => {
                    if heading.is_some() {
                        heading_text.push_str(t)
                    }
                }
                Event::End(_) => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        let end = range.end;
                        if let Some(level) = heading.take() {
                            if let Some((s, _, h)) = pending.take() {
                                ranges.push((s..block_start, h));
                            }
                            path.truncate(level.saturating_sub(1));
                            path.push(heading_text.clone());
                            pending = Some((block_start, end, path.clone()));
                        } else if let Some((start, old_end, h)) = pending.take() {
                            let combined = &text[start..end];
                            if !block_is_code
                                && approximate_tokens(combined) > config.max_tokens_approx
                                && approximate_tokens(&text[start..old_end])
                                    >= config.target_tokens_approx
                            {
                                ranges.push((start..block_start, h));
                                pending = Some((block_start, end, path.clone()));
                            } else {
                                pending = Some((start, end, h));
                            }
                        } else {
                            pending = Some((block_start, end, path.clone()));
                        }
                    }
                }
                Event::Rule if depth == 0 => {
                    if let Some((s, _, h)) = pending.take() {
                        pending = Some((s, range.end, h));
                    } else {
                        pending = Some((range.start, range.end, path.clone()));
                    }
                }
                _ => {}
            }
        }
        if let Some((s, _, h)) = pending {
            ranges.push((s..text.len(), h));
        }
        if ranges.is_empty() {
            ranges.push((0..text.len(), document.heading_path.clone()));
        }
    }
    let mut duplicates = HashMap::new();
    let mut chunks = Vec::new();
    for (range, heading_path) in ranges {
        let content = text[range].to_owned();
        if content.trim().is_empty() {
            continue;
        }
        if approximate_tokens(&content) > config.max_tokens_approx {
            tracing::warn!(document_id=%document.document_id,"oversized indivisible Markdown block retained");
        }
        let hash = content_hash(&content);
        let ordinal = duplicates
            .entry((heading_path.clone(), hash.clone()))
            .or_insert(0usize);
        let id = chunk_id(&document.document_id, &heading_path, &hash, *ordinal);
        *ordinal += 1;
        chunks.push(Chunk {
            chunk_id: id,
            document_id: document.document_id.clone(),
            kind: document.kind,
            title: document.title.clone(),
            heading_path,
            source: document.source.clone(),
            language: document.language.clone(),
            code_blocks: code_blocks(&content),
            content,
            tags: document.tags.clone(),
            parent_document_id: Some(
                document
                    .parent_document_id
                    .clone()
                    .unwrap_or_else(|| document.document_id.clone()),
            ),
            content_hash: hash,
            verification_status: document.verification_status,
            verification_evidence: document.verification_evidence.clone(),
            example_metadata: document.example_metadata.clone(),
        });
    }
    Ok(chunks)
}
