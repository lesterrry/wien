use crate::{CodeBlock, Document, DocumentKind, Error, Result, content_hash, document_id};
use pulldown_cmark::{Event, Options, Parser as MarkdownParser, Tag, TagEnd};
use scraper::{ElementRef, Html, Selector};
use std::collections::{BTreeMap, BTreeSet};

fn normalized(text: &str) -> String {
    text.replace("\r\n", "\n")
}
fn set_content(document: &mut Document, content: String) {
    document.content_hash = content_hash(&content);
    document.content = content;
}
fn frontmatter(text: &str) -> (&str, Option<String>) {
    if !text.starts_with("---\n") {
        return (text, None);
    }
    if let Some(end) = text[4..].find("\n---\n") {
        let title = text[4..4 + end].lines().find_map(|line| {
            line.strip_prefix("title:")
                .map(|t| t.trim().trim_matches(['\'', '"']).to_owned())
        });
        return (&text[4 + end + 5..], title);
    }
    (text, None)
}
fn default_title(document: &Document) -> bool {
    document
        .source
        .source_path
        .as_ref()
        .and_then(|p| std::path::Path::new(p).file_stem())
        .and_then(|p| p.to_str())
        == Some(document.title.as_str())
}

pub fn example_extraction_key(heading: &[String], code: &str, ordinal: usize) -> String {
    format!(
        "example:{}:{}:{ordinal}",
        heading.join(" > "),
        content_hash(code)
    )
}
fn identity_path(document: &Document) -> &str {
    // Repository and local sources use POSIX relative paths; Pressbooks uses canonical URL.
    if let Some(url) = document
        .source
        .source_url
        .as_deref()
        .filter(|url| document.document_id == document_id(&document.source.source_id, url, ""))
    {
        url
    } else {
        document
            .source
            .source_path
            .as_deref()
            .or(document.source.source_url.as_deref())
            .unwrap_or_default()
    }
}
fn fence(code: &str, language: &str) -> String {
    let longest = code.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let marker = "`".repeat(3.max(longest + 1));
    format!(
        "{marker}{language}\n{code}{}{marker}",
        if code.ends_with('\n') { "" } else { "\n" }
    )
}
fn derived_example(
    parent: &Document,
    block: CodeBlock,
    heading: Vec<String>,
    prose: &str,
    ordinal: usize,
) -> Document {
    let mut example = parent.clone();
    let key = example_extraction_key(&heading, &block.code, ordinal);
    example.document_id = document_id(&parent.source.source_id, identity_path(parent), &key);
    example.parent_document_id = Some(parent.document_id.clone());
    example.kind = DocumentKind::Example;
    example.heading_path = heading;
    let code = fence(
        &block.code,
        block.language.as_deref().unwrap_or("javascript"),
    );
    set_content(
        &mut example,
        if prose.trim().is_empty() {
            code
        } else {
            format!("{}\n\n{code}", prose.trim_end())
        },
    );
    example.code_blocks = vec![block];
    example
}

pub fn extract_markdown(text: &str, mut base: Document, gaps: &mut Vec<String>) -> Vec<Document> {
    let text = normalized(text);
    let (body, front_title) = frontmatter(&text);
    if body.trim().is_empty() {
        gaps.push(format!("empty document skipped: {}", identity_path(&base)));
        return vec![];
    }
    if default_title(&base)
        && let Some(title) = front_title
    {
        base.title = title;
    }
    let mut headings: Vec<String> = vec![];
    let mut heading = String::new();
    let mut heading_level = 0;
    let mut in_heading = false;
    let mut paragraph_start = None;
    let mut prose = String::new();
    let mut code: Option<CodeBlock> = None;
    let mut examples = Vec::new();
    let mut duplicates = BTreeMap::new();
    let mut first_heading = None;
    let mut blocks = Vec::new();
    for (event, range) in MarkdownParser::new_ext(body, Options::all()).into_offset_iter() {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                in_heading = true;
                heading.clear();
                heading_level = level as usize;
            }
            Event::End(TagEnd::Heading(_)) => {
                in_heading = false;
                if first_heading.is_none() {
                    first_heading = Some(heading.clone());
                }
                headings.truncate(heading_level.saturating_sub(1));
                headings.push(heading.clone());
                prose.clear();
            }
            Event::Start(Tag::Paragraph) => {
                paragraph_start = Some(range.start);
            }
            Event::End(TagEnd::Paragraph) => {
                if let Some(start) = paragraph_start.take() {
                    prose = body[start..range.end].to_owned();
                }
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                let language = match kind {
                    pulldown_cmark::CodeBlockKind::Fenced(info) => {
                        info.split_whitespace().next().map(str::to_owned)
                    }
                    pulldown_cmark::CodeBlockKind::Indented => None,
                };
                code = Some(CodeBlock {
                    language,
                    code: String::new(),
                });
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some(block) = code.take() {
                    if base.kind != DocumentKind::Example
                        && is_javascript(block.language.as_deref())
                    {
                        let counter = duplicates
                            .entry((headings.clone(), content_hash(&block.code)))
                            .or_insert(0usize);
                        examples.push(derived_example(
                            &base,
                            block.clone(),
                            headings.clone(),
                            &prose,
                            *counter,
                        ));
                        *counter += 1;
                    }
                    blocks.push(block);
                }
            }
            Event::Text(text) | Event::Code(text) => {
                if in_heading {
                    heading.push_str(&text);
                }
                if let Some(block) = &mut code {
                    block.code.push_str(&text);
                }
            }
            Event::SoftBreak | Event::HardBreak if in_heading => {
                heading.push(' ');
            }
            _ => {}
        }
    }
    if default_title(&base)
        && let Some(title) = first_heading
    {
        base.title = title;
    }
    base.code_blocks = blocks;
    // pulldown-cmark preserves an open fence to EOF; expose that fact to operators.
    let mut open: Option<(char, usize)> = None;
    for line in body.lines() {
        let line = line.trim_start_matches(' ');
        let ch = line.chars().next().unwrap_or(' ');
        if matches!(ch, '`' | '~') {
            let count = line.chars().take_while(|c| *c == ch).count();
            if count >= 3 {
                match open {
                    Some((marker, length)) if marker == ch && count >= length => open = None,
                    None => open = Some((ch, count)),
                    _ => {}
                }
            }
        }
    }
    if open.is_some() {
        gaps.push(format!(
            "unclosed code fence retained to EOF: {}",
            identity_path(&base)
        ));
    }
    set_content(&mut base, body.to_owned());
    // Derived documents inherit the final page title as well as the actual heading/prose context.
    for example in &mut examples {
        example.title = base.title.clone();
    }
    let mut result = vec![base];
    result.extend(examples);
    result
}
fn is_javascript(language: Option<&str>) -> bool {
    matches!(
        language,
        Some("js" | "javascript" | "strudel" | "jsx" | "mjs")
    )
}
pub fn extract_code(text: &str, mut base: Document) -> Vec<Document> {
    let code = normalized(text);
    if code.trim().is_empty() {
        return vec![];
    }
    base.kind = DocumentKind::Example;
    base.code_blocks = vec![CodeBlock {
        language: Some("javascript".into()),
        code: code.clone(),
    }];
    set_content(&mut base, fence(&code, "javascript"));
    vec![base]
}

fn javascript_parser() -> Result<tree_sitter::Parser> {
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&tree_sitter_javascript::LANGUAGE.into())
        .map_err(|e| Error::Other(format!("JavaScript grammar error: {e}")))?;
    Ok(parser)
}
fn visit_nodes(node: tree_sitter::Node<'_>, callback: &mut impl FnMut(tree_sitter::Node<'_>)) {
    callback(node);
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit_nodes(child, callback);
    }
}
fn literal_from_jsx(tag: &str, attribute: &str) -> Result<Option<String>> {
    // Parsing a standalone JSX element avoids treating Markdown prose as JavaScript.
    let element = if tag.trim_end().ends_with("/>") {
        tag.to_owned()
    } else {
        format!("{tag}</MiniRepl>")
    };
    let source = format!("const __rag_literal = ({element});");
    let mut parser = javascript_parser()?;
    let tree = parser
        .parse(&source, None)
        .ok_or_else(|| Error::Other("JavaScript parser returned no tree".into()))?;
    if tree.root_node().has_error() {
        return Ok(None);
    }
    let mut result = None;
    visit_nodes(tree.root_node(), &mut |node| {
        if node.kind() != "jsx_attribute" {
            return;
        }
        let text = &source[node.byte_range()];
        let name = text.split('=').next().unwrap_or_default().trim();
        if name != attribute {
            return;
        }
        let Some(mut value) = node.named_child(node.named_child_count().saturating_sub(1)) else {
            return;
        };
        if value.kind() == "jsx_expression" {
            if value.named_child_count() != 1 {
                return;
            }
            let Some(inner) = value.named_child(0) else {
                return;
            };
            value = inner;
        }
        if !matches!(value.kind(), "string" | "template_string") {
            return;
        }
        let mut dynamic = false;
        visit_nodes(value, &mut |part| {
            if part.kind() == "template_substitution" {
                dynamic = true;
            }
        });
        if !dynamic {
            result = decode_js_literal(&source[value.byte_range()]);
        }
    });
    Ok(result)
}
fn decode_js_literal(literal: &str) -> Option<String> {
    let quote = literal.chars().next()?;
    if !matches!(quote, '\'' | '"' | '`') || literal.chars().last()? != quote {
        return None;
    }
    let mut chars = literal[quote.len_utf8()..literal.len() - quote.len_utf8()]
        .chars()
        .peekable();
    let mut result = String::new();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            result.push(ch);
            continue;
        }
        match chars.next()? {
            'n' => result.push('\n'),
            'r' => result.push('\r'),
            't' => result.push('\t'),
            'b' => result.push('\u{0008}'),
            'f' => result.push('\u{000c}'),
            'v' => result.push('\u{000b}'),
            '0' => {
                if chars.peek().is_some_and(char::is_ascii_digit) {
                    return None;
                }
                result.push('\0');
            }
            '\n' => {}
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
            }
            'x' => {
                let digits: String = chars.by_ref().take(2).collect();
                if digits.len() != 2 {
                    return None;
                }
                result.push(char::from_u32(u32::from_str_radix(&digits, 16).ok()?)?);
            }
            'u' => {
                let scalar = if chars.peek() == Some(&'{') {
                    chars.next();
                    let mut digits = String::new();
                    loop {
                        let next = chars.next()?;
                        if next == '}' {
                            break;
                        }
                        digits.push(next);
                    }
                    u32::from_str_radix(&digits, 16).ok()?
                } else {
                    let digits: String = chars.by_ref().take(4).collect();
                    if digits.len() != 4 {
                        return None;
                    }
                    let first = u32::from_str_radix(&digits, 16).ok()?;
                    if (0xd800..=0xdbff).contains(&first) {
                        if chars.next()? != '\\' || chars.next()? != 'u' {
                            return None;
                        }
                        let next: String = chars.by_ref().take(4).collect();
                        let second = u32::from_str_radix(&next, 16).ok()?;
                        if !(0xdc00..=0xdfff).contains(&second) {
                            return None;
                        }
                        0x10000 + ((first - 0xd800) << 10) + second - 0xdc00
                    } else {
                        first
                    }
                };
                result.push(char::from_u32(scalar)?);
            }
            digit if digit.is_ascii_digit() => return None,
            other => result.push(other),
        }
    }
    Some(result)
}

// Find an opening tag's true end without stopping at > inside literals or expressions.
fn tag_end(text: &str, start: usize) -> Option<usize> {
    let mut quote = None;
    let mut escaped = false;
    let mut braces = 0usize;
    for (offset, ch) in text[start..].char_indices() {
        if let Some(marker) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == marker {
                quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' | '`' => quote = Some(ch),
            '{' => braces += 1,
            '}' => braces = braces.saturating_sub(1),
            '>' if braces == 0 => return Some(start + offset + 1),
            _ => {}
        }
    }
    None
}
pub fn jsdoc_references(text: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let mut fenced = None;
    for line in text.lines() {
        if mdx_fence(line, &mut fenced) || fenced.is_some() {
            continue;
        }
        let mut position = 0;
        while let Some(start) = next_markup(line, position) {
            let Some(end) = tag_end(line, start) else {
                break;
            };
            let tag = &line[start..end];
            if markup_name(tag) == "JsDoc"
                && !tag.starts_with("</")
                && let Ok(Some(value)) = literal_from_jsx(tag, "name")
            {
                names.insert(value);
            }
            position = end;
        }
    }
    names
}
fn mdx_fence(line: &str, open: &mut Option<(char, usize)>) -> bool {
    let trimmed = line.trim_start();
    let marker = trimmed.chars().next().unwrap_or(' ');
    let length = trimmed.chars().take_while(|c| *c == marker).count();
    if !matches!(marker, '`' | '~') || length < 3 {
        return false;
    }
    match *open {
        Some((ch, n)) if ch == marker && length >= n => *open = None,
        None => *open = Some((marker, length)),
        _ => {}
    }
    true
}
pub fn extract_mdx(
    text: &str,
    mut base: Document,
    catalog: &BTreeMap<String, &Document>,
    gaps: &mut Vec<String>,
) -> Result<Vec<Document>> {
    let normalized = normalized(text);
    let (body, title) = frontmatter(&normalized);
    let mut clean = String::new();
    let mut import_open = false;
    let mut fence_open: Option<(char, usize)> = None;
    // Imports are module syntax, never retrieval prose. Preserve fenced JavaScript byte-for-byte.
    let mut lines = body.split_inclusive('\n');
    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        if fence_open.is_none()
            && (trimmed.starts_with("import ") || trimmed.starts_with("export ") || import_open)
        {
            import_open = !trimmed.trim_end().ends_with(';');
            continue;
        }
        if mdx_fence(line, &mut fence_open) {
            clean.push_str(line);
            continue;
        }
        if fence_open.is_some() {
            clean.push_str(line);
            continue;
        }
        let mut combined = line.to_owned();
        // JSX attributes and template literals in the real corpus span lines.
        // Accumulate a complete opening tag before handing it to tree-sitter.
        while let Some(start) =
            next_markup(&combined, 0).filter(|start| tag_end(&combined, *start).is_none())
        {
            if let Some(next) = lines.next() {
                combined.push_str(next);
            } else {
                gaps.push(format!(
                    "unclosed MDX tag skipped: {}",
                    identity_path(&base)
                ));
                combined.truncate(start);
                break;
            }
        }
        clean.push_str(&clean_mdx_line(&combined, &mut base, catalog, gaps)?);
    }
    if default_title(&base)
        && let Some(title) = title
    {
        base.title = title;
    }
    Ok(extract_markdown(&clean, base, gaps))
}
fn next_markup(text: &str, position: usize) -> Option<usize> {
    let mut ticks = 0usize;
    let bytes = text.as_bytes();
    let mut index = position;
    while index < bytes.len() {
        if bytes[index] == b'`' {
            let count = bytes[index..]
                .iter()
                .take_while(|byte| **byte == b'`')
                .count();
            if ticks == 0 {
                ticks = count;
            } else if ticks == count {
                ticks = 0;
            }
            index += count;
            continue;
        }
        if ticks == 0 && bytes[index] == b'<' {
            let next = bytes.get(index + 1).copied();
            if next.is_some_and(|b| b.is_ascii_alphabetic() || b == b'/') {
                return Some(index);
            }
        }
        index += 1;
    }
    None
}
fn markup_name(tag: &str) -> &str {
    tag.trim_start_matches('<')
        .trim_start_matches('/')
        .split(|c: char| c.is_whitespace() || c == '/' || c == '>')
        .next()
        .unwrap_or_default()
}
fn api_provenance(document: &Document) -> String {
    let source = &document.source;
    let mut provenance = format!(
        "API source for {}: URL: {}; path: {}; revision: {}",
        document.title,
        source.source_url.as_deref().unwrap_or("not recorded"),
        source.source_path.as_deref().unwrap_or("not recorded"),
        source.source_revision.as_deref().unwrap_or("not recorded"),
    );
    if let Some(license) = &source.license {
        provenance.push_str(&format!(
            "; license: {}; license URL: {}; attribution: {}",
            license.name.as_deref().unwrap_or("not recorded"),
            license.url.as_deref().unwrap_or("not recorded"),
            license.attribution.as_deref().unwrap_or("not recorded"),
        ));
    } else {
        provenance.push_str("; license: not recorded");
    }
    provenance
}
fn clean_mdx_line(
    line: &str,
    base: &mut Document,
    catalog: &BTreeMap<String, &Document>,
    gaps: &mut Vec<String>,
) -> Result<String> {
    let mut result = String::new();
    let mut position = 0;
    while let Some(start) = next_markup(line, position) {
        result.push_str(&line[position..start]);
        let Some(end) = tag_end(line, start) else {
            result.push_str(&line[start..]);
            return Ok(result);
        };
        let tag = &line[start..end];
        let name = markup_name(tag);
        if name == "MiniRepl" && !tag.starts_with("</") {
            match literal_from_jsx(tag, "tune")? {
                Some(code) => {
                    result.push_str("\n\n");
                    result.push_str(&fence(&code, "javascript"));
                    result.push_str("\n\n");
                }
                None => gaps.push(format!(
                    "dynamic/unsupported MiniRepl skipped without evaluation: {}",
                    identity_path(base)
                )),
            }
        } else if name == "JsDoc" && !tag.starts_with("</") {
            match literal_from_jsx(tag, "name")? {
                Some(name) => {
                    if let Some(document) = catalog.get(&name) {
                        let provenance = api_provenance(document);
                        if !base.source.notices.contains(&provenance) {
                            base.source.notices.push(provenance.clone());
                        }
                        result.push_str("\n\n> ");
                        result.push_str(&provenance);
                        result.push_str("\n\n");
                        result.push_str(document.content.trim());
                        result.push_str("\n\n");
                    } else {
                        gaps.push(format!(
                            "unresolved JsDoc reference {name}: {}",
                            identity_path(base)
                        ));
                    }
                }
                None => gaps.push(format!(
                    "dynamic/unsupported JsDoc name skipped without evaluation: {}",
                    identity_path(base)
                )),
            }
        } else if matches!(
            name,
            "Box"
                | "QA"
                | "div"
                | "span"
                | "br"
                | "hr"
                | "a"
                | "strong"
                | "em"
                | "p"
                | "img"
                | "details"
                | "summary"
                | "blockquote"
        ) {
            if matches!(name, "br" | "hr" | "p" | "div" | "Box" | "QA") {
                result.push('\n');
            }
            if name == "img" {
                gaps.push(format!(
                    "MDX image omitted, notation not transcribed: {}",
                    identity_path(base)
                ));
            }
        } else if name.chars().next().is_some_and(char::is_uppercase) {
            gaps.push(format!(
                "unsupported MDX component {name} omitted: {}",
                identity_path(base)
            ));
        } else if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '-') {
            // Not an HTML/JSX tag (for example, a Markdown autolink).
            result.push_str(tag);
        }
        position = end;
    }
    result.push_str(&line[position..]);
    Ok(result)
}

pub fn extract_jsdoc(
    text: &str,
    base: &Document,
    wanted: &BTreeSet<String>,
    found: &mut BTreeSet<String>,
    gaps: &mut Vec<String>,
) -> Result<Vec<Document>> {
    let text = normalized(text);
    let mut parser = javascript_parser()?;
    let tree = parser
        .parse(&text, None)
        .ok_or_else(|| Error::Other("JavaScript parser returned no tree".into()))?;
    let mut comments = Vec::new();
    visit_nodes(tree.root_node(), &mut |node| {
        if node.kind() == "comment" && text[node.byte_range()].starts_with("/**") {
            comments.push((
                node.start_position().row + 1,
                text[node.byte_range()].to_owned(),
            ));
        }
    });
    let mut documents = Vec::new();
    for (line, comment) in comments {
        let body = strip_jsdoc(&comment);
        let Some(name) = doc_tag(&body, "name") else {
            continue;
        };
        let member = doc_tag(&body, "memberof");
        let longname = if name.contains('.') {
            name.clone()
        } else if let Some(member) = member {
            format!("{member}.{name}")
        } else {
            name.clone()
        };
        let bare = longname.strip_prefix("Pattern.").unwrap_or(&longname);
        if !wanted.is_empty() && !wanted.contains(&longname) && !wanted.contains(bare) {
            continue;
        }
        found.insert(longname.clone());
        found.insert(bare.to_owned());
        let mut document = base.clone();
        document.document_id = document_id(
            &base.source.source_id,
            identity_path(base),
            &format!("api:{longname}"),
        );
        document.kind = DocumentKind::Api;
        document.title = longname.clone();
        document.heading_path = vec![longname];
        if let Some(url) = &mut document.source.source_url {
            *url = format!("{}#L{line}", url.replace("/raw/commit/", "/src/commit/"));
        }
        if let Some(tags) = doc_tag(&body, "tags") {
            document.tags.extend(
                tags.split(|c: char| c.is_whitespace() || c == ',')
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            );
        }
        let (content, codes) = jsdoc_examples(&body);
        document.code_blocks = codes.clone();
        set_content(&mut document, content);
        if document.content.trim().is_empty() {
            gaps.push(format!("empty API comment skipped: {}", document.title));
            continue;
        }
        let mut examples = Vec::new();
        let mut ordinals = BTreeMap::new();
        for block in codes {
            let counter = ordinals.entry(content_hash(&block.code)).or_insert(0usize);
            examples.push(derived_example(
                &document,
                block,
                document.heading_path.clone(),
                &document.title,
                *counter,
            ));
            *counter += 1;
        }
        documents.push(document);
        documents.extend(examples);
    }
    Ok(documents)
}
fn strip_jsdoc(comment: &str) -> String {
    comment
        .trim_start_matches("/**")
        .trim_end_matches("*/")
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if let Some(rest) = trimmed.strip_prefix('*') {
                rest.strip_prefix(' ').unwrap_or(rest)
            } else if trimmed.is_empty() {
                ""
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim_matches('\n')
        .to_owned()
}
fn doc_tag(body: &str, tag: &str) -> Option<String> {
    let prefix = format!("@{tag}");
    body.lines().find_map(|line| {
        line.trim_start()
            .strip_prefix(&prefix)
            .filter(|value| value.starts_with(char::is_whitespace))
            .map(|value| value.trim().to_owned())
    })
}
fn jsdoc_examples(body: &str) -> (String, Vec<CodeBlock>) {
    let mut content = String::new();
    let mut code: Option<String> = None;
    let mut codes = Vec::new();
    for line in body.lines() {
        if let Some(value) = line
            .trim_start()
            .strip_prefix("@example")
            .filter(|tail| tail.is_empty() || tail.starts_with(char::is_whitespace))
        {
            if let Some(code) = code.take() {
                push_jsdoc_example(&mut content, &mut codes, code);
            }
            code = Some(if value.trim().is_empty() {
                String::new()
            } else {
                format!("{}\n", value.trim_start())
            });
        } else if line.trim_start().starts_with('@') {
            if let Some(code) = code.take() {
                push_jsdoc_example(&mut content, &mut codes, code);
            }
            content.push_str(line);
            content.push('\n');
        } else if let Some(code) = &mut code {
            code.push_str(line);
            code.push('\n');
        } else {
            content.push_str(line);
            content.push('\n');
        }
    }
    if let Some(code) = code {
        push_jsdoc_example(&mut content, &mut codes, code);
    }
    (content, codes)
}
fn push_jsdoc_example(content: &mut String, codes: &mut Vec<CodeBlock>, code: String) {
    content.push_str("\n@example\n");
    content.push_str(&fence(&code, "javascript"));
    content.push('\n');
    codes.push(CodeBlock {
        language: Some("javascript".into()),
        code,
    });
}

fn selector(value: &str) -> Result<Selector> {
    Selector::parse(value).map_err(|e| Error::Other(format!("invalid built-in HTML selector: {e}")))
}
fn element_text(element: ElementRef<'_>) -> String {
    element
        .text()
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
pub fn extract_html(
    text: &str,
    mut base: Document,
    pressbooks: bool,
    gaps: &mut Vec<String>,
) -> Result<Vec<Document>> {
    let html = Html::parse_document(text);
    let chapter = if pressbooks {
        html.select(&selector("section[data-type=chapter]")?).next().ok_or_else(|| Error::Other("Pressbooks chapter selector section[data-type=chapter] is missing; refusing whole-DOM fallback".into()))?
    } else {
        html.select(&selector("body")?)
            .next()
            .unwrap_or_else(|| html.root_element())
    };
    if let Some(title) = html.select(&selector("h1.entry-title")?).next()
        && default_title(&base)
    {
        base.title = element_text(title);
    }
    let authors = chapter
        .select(&selector("p[data-type=author]")?)
        .map(element_text)
        .collect::<Vec<_>>();
    let licenses = html
        .select(&selector(".license-attribution")?)
        .map(element_text)
        .collect::<Vec<_>>();
    if !authors.is_empty() || !licenses.is_empty() {
        let license = base.source.license.get_or_insert_with(Default::default);
        let mut attribution = license.attribution.clone().into_iter().collect::<Vec<_>>();
        if !authors.is_empty() {
            attribution.push(format!("Chapter authors: {}", authors.join("; ")));
        }
        attribution.extend(licenses);
        license.attribution = Some(attribution.join("\n"));
    }
    for heading in chapter.select(&selector("h1,h2,h3,h4,h5,h6")?) {
        if element_text(heading)
            .to_lowercase()
            .contains("media attributions")
        {
            let mut media = String::from("Media Attributions:");
            let mut sibling = heading.next_sibling();
            while let Some(node) = sibling {
                if let Some(element) = ElementRef::wrap(node) {
                    if matches!(
                        element.value().name(),
                        "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                    ) {
                        break;
                    }
                    media.push('\n');
                    media.push_str(&element_text(element));
                }
                sibling = node.next_sibling();
            }
            base.source.notices.push(media);
        }
    }
    if pressbooks {
        base.source.notices.push("Notated images are retained as alt text only, not transcribed. Media licenses are independent; assets and audio were not downloaded.".into());
    }
    let mut content = String::new();
    render_element(chapter, &mut content);
    base.kind = if pressbooks {
        DocumentKind::Theory
    } else {
        base.kind
    };
    Ok(extract_markdown(&content, base, gaps))
}
fn render_element(element: ElementRef<'_>, output: &mut String) {
    let name = element.value().name();
    if matches!(
        name,
        "script" | "style" | "nav" | "form" | "iframe" | "noscript" | "button" | "input" | "svg"
    ) {
        return;
    }
    if name == "pre" {
        let code = element.text().collect::<String>();
        output.push_str("\n\n");
        output.push_str(&fence(&code, ""));
        output.push_str("\n\n");
        return;
    }
    if name == "img" {
        if let Some(alt) = element.value().attr("alt") {
            output.push_str("[Image: ");
            output.push_str(alt);
            output.push(']');
        }
        return;
    }
    let heading = match name {
        "h1" => Some(1),
        "h2" => Some(2),
        "h3" => Some(3),
        "h4" => Some(4),
        "h5" => Some(5),
        "h6" => Some(6),
        _ => None,
    };
    let block = matches!(
        name,
        "p" | "div"
            | "section"
            | "ul"
            | "ol"
            | "table"
            | "figure"
            | "figcaption"
            | "caption"
            | "blockquote"
    );
    if block || heading.is_some() {
        output.push_str("\n\n");
    }
    if let Some(level) = heading {
        output.push_str(&"#".repeat(level));
        output.push(' ');
    }
    if name == "li" {
        output.push_str("\n- ");
    }
    if name == "br" || name == "tr" {
        output.push('\n');
    }
    if name == "td" || name == "th" {
        output.push_str(" | ");
    }
    if name == "code" {
        output.push('`');
    }
    for child in element.children() {
        match child.value() {
            scraper::Node::Text(text) => {
                // Collapse HTML layout whitespace, retaining separation around inline elements.
                let text = &text.text;
                let mut whitespace = false;
                for ch in text.chars() {
                    if ch.is_whitespace() {
                        whitespace = true;
                    } else {
                        if whitespace && !output.ends_with(char::is_whitespace) {
                            output.push(' ');
                        }
                        output.push(ch);
                        whitespace = false;
                    }
                }
                if whitespace && !output.ends_with(char::is_whitespace) {
                    output.push(' ');
                }
            }
            scraper::Node::Element(_) => {
                if let Some(element) = ElementRef::wrap(child) {
                    render_element(element, output);
                }
            }
            _ => {}
        }
    }
    if name == "code" {
        output.push('`');
    }
    if block || heading.is_some() {
        output.push_str("\n\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SourceRef, VerificationStatus};
    fn document(path: &str) -> Document {
        Document {
            document_id: document_id("test", path, ""),
            kind: DocumentKind::Api,
            title: "fixture".into(),
            heading_path: vec![],
            source: SourceRef {
                source_id: "test".into(),
                source_path: Some(path.into()),
                ..Default::default()
            },
            language: Some("en".into()),
            content: String::new(),
            code_blocks: vec![],
            tags: vec![],
            parent_document_id: None,
            content_hash: String::new(),
            verification_status: VerificationStatus::SourceOnly,
            verification_evidence: None,
            example_metadata: None,
        }
    }
    #[test]
    fn literal_mdx_is_decoded_and_dynamic_is_not_executed() {
        let text = "---\ntitle: Fixture\n---\nimport { MiniRepl } from './x';\n# Rhythm\nSome prose.\n<MiniRepl tune={`s(\\`bd\\`)\\n.slow(2)`} />\n<MiniRepl tune={`s(${unsafeCall()})`} />\n";
        let mut gaps = vec![];
        let docs = extract_mdx(text, document("test.mdx"), &BTreeMap::new(), &mut gaps).unwrap();
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0].code_blocks[0].code, "s(`bd`)\n.slow(2)\n");
        assert!(!docs[0].content.contains("import "));
        assert!(!docs[0].content.contains("unsafeCall"));
        assert!(gaps.iter().any(|g| g.contains("dynamic")));
        assert_eq!(
            docs[1].parent_document_id.as_deref(),
            Some(docs[0].document_id.as_str())
        );
    }
    #[test]
    fn jsdoc_never_indexes_implementation_or_unnamed_comments() {
        let text = "/** Example API.\n * @memberof Pattern\n * @name slow\n * @param {number} factor time\n * @example\n * s(\"bd\")\n *   .slow(2)\n */\nconst secretImplementation = 42;\n/** @example unnamed() */";
        let docs = extract_jsdoc(
            text,
            &document("pattern.mjs"),
            &BTreeSet::from(["slow".into()]),
            &mut BTreeSet::new(),
            &mut vec![],
        )
        .unwrap();
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0].title, "Pattern.slow");
        assert!(docs[0].content.contains("@param"));
        assert!(!docs[0].content.contains("secretImplementation"));
        assert_eq!(docs[1].code_blocks[0].code, "s(\"bd\")\n  .slow(2)\n");
    }
    #[test]
    fn chapter_selector_is_required_and_media_not_transcribed() {
        assert!(
            extract_html(
                "<html>not a chapter</html>",
                document("a.html"),
                true,
                &mut vec![]
            )
            .is_err()
        );
        let text = "<h1 class='entry-title'>Theory</h1><section data-type='chapter'><p data-type='author'>A. Author</p><h2>Rhythm</h2><p>Three <em>accents</em>.</p><img alt='notation' src='x'><script>evil()</script></section><div class='license-attribution'>CC BY-SA except noted</div>";
        let docs = extract_html(text, document("a.html"), true, &mut vec![]).unwrap();
        assert!(docs[0].content.contains("accents"));
        assert!(docs[0].content.contains("notation"));
        assert!(!docs[0].content.contains("evil"));
        assert!(
            docs[0]
                .source
                .license
                .as_ref()
                .unwrap()
                .attribution
                .as_ref()
                .unwrap()
                .contains("A. Author")
        );
    }
    #[test]
    fn code_and_nested_fence_headings_are_preserved() {
        let text = "# Page\r\n## Real\r\nIntro.\r\n```javascript\r\n// # Not heading\r\ns(\"bd\")\r\n```\r\n";
        let docs = extract_markdown(text, document("a.md"), &mut vec![]);
        assert_eq!(docs[0].content, text.replace("\r\n", "\n"));
        assert_eq!(docs[0].code_blocks[0].code, "// # Not heading\ns(\"bd\")\n");
        assert_eq!(docs[1].heading_path, vec!["Page", "Real"]);
    }
    #[test]
    fn original_parser_fixtures_cover_multiline_jsx_comments_and_html() {
        let mdx = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/parsers/literal.mdx"
        ));
        let mut gaps = vec![];
        let docs = extract_mdx(mdx, document("fixture.mdx"), &BTreeMap::new(), &mut gaps).unwrap();
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0].code_blocks[0].code, "s(`bd ~ sd`)\n  .slow(2)\n");
        assert_eq!(gaps.iter().filter(|g| g.contains("dynamic")).count(), 2);
        assert!(!docs[0].content.contains("notExecuted"));
        let jsdoc = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/parsers/comments.mjs"
        ));
        let comments = extract_jsdoc(
            jsdoc,
            &document("fixture.mjs"),
            &BTreeSet::new(),
            &mut BTreeSet::new(),
            &mut vec![],
        )
        .unwrap();
        assert_eq!(comments.len(), 2);
        assert!(
            !comments[0]
                .content
                .contains("implementationMustNotBeIndexed")
        );
        let html = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/parsers/chapter.html"
        ));
        let chapters = extract_html(html, document("fixture.html"), true, &mut vec![]).unwrap();
        assert!(chapters[0].content.contains("3 + 3 + 2"));
        assert!(
            chapters[0]
                .source
                .notices
                .iter()
                .any(|notice| notice.contains("Media Attributions"))
        );
        assert!(!chapters[0].content.contains("notExecuted"));
    }
    #[test]
    fn dynamic_calls_are_not_misidentified_as_string_literals() {
        assert_eq!(
            literal_from_jsx("<MiniRepl tune={call(\"unsafe\")} />", "tune").unwrap(),
            None
        );
        assert_eq!(
            literal_from_jsx("<MiniRepl tune={\"a\" + \"b\"} />", "tune").unwrap(),
            None
        );
        assert_eq!(
            literal_from_jsx("<MiniRepl tune={'s(\"bd\")'} />", "tune").unwrap(),
            Some("s(\"bd\")".into())
        );
        let docs = extract_mdx(
            "Inline `note(\"<c d>\")` remains code.\n",
            document("fixture.mdx"),
            &BTreeMap::new(),
            &mut vec![],
        )
        .unwrap();
        assert!(docs[0].content.contains("`note(\"<c d>\")`"));
    }
}
