//! Compatibility step for httpgenerator 1.1.0, which ignores JSON request examples.
//! Routes, headers, variables, and filenames still come from httpgenerator.
use std::{env, fs, io, path::Path};

use serde_json::Value;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err("Usage: apply-http-examples <openapi.json> <http-directory>".into());
    }
    let spec: Value = serde_json::from_slice(&fs::read(&args[0])?)?;
    for entry in fs::read_dir(&args[1])? {
        let path = entry?.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "http")
        {
            apply_example(&spec, &path)?;
        }
    }
    Ok(())
}

fn apply_example(spec: &Value, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    // Swagger uses the current origin; REST Client examples need an absolute local URL.
    let source =
        fs::read_to_string(path)?.replace("@baseUrl = /\n", "@baseUrl = http://127.0.0.1:3001\n");
    let lines: Vec<_> = source.lines().collect();
    let invalid = || io::Error::other("Unexpected httpgenerator output format");
    let (method, route) = lines
        .iter()
        .find_map(|line| line.strip_prefix("### Request: "))
        .and_then(|request| request.split_once(' '))
        .ok_or_else(invalid)?;
    let method = method.to_owned();
    let route = route.to_owned();
    let operation = &spec["paths"][&route][method.to_ascii_lowercase()];
    let source = if operation["security"]
        .as_array()
        .is_some_and(|requirements| requirements.iter().any(|r| r.get("session").is_some()))
    {
        source
            .replace(
                "@contentType = application/json",
                "@contentType = application/json\n@sessionToken = paste-token-from-login",
            )
            .replace(
                "Content-Type: {{contentType}}",
                "Content-Type: {{contentType}}\nAuthorization: Bearer {{sessionToken}}",
            )
    } else {
        source
    };
    let lines: Vec<_> = source.lines().collect();
    let media = &operation["requestBody"]["content"]["application/json"];
    let Some(example) = media.get("example") else {
        fs::write(path, format!("{}\n", source.trim_end()))?;
        return Ok(());
    };
    let request = lines
        .iter()
        .position(|line| line.starts_with(&format!("{method} ")))
        .ok_or_else(invalid)?;
    let end_headers = request
        + 1
        + lines[request + 1..]
            .iter()
            .position(|line| line.is_empty())
            .ok_or_else(invalid)?;
    fs::write(
        path,
        format!(
            "{}\n\n{}\n",
            lines[..end_headers].join("\n"),
            serde_json::to_string_pretty(example)?
        ),
    )?;
    Ok(())
}
