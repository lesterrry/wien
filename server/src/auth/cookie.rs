use super::Error;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};

fn local(headers: &HeaderMap) -> bool {
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    host == "localhost"
        || host.starts_with("localhost:")
        || host == "127.0.0.1"
        || host.starts_with("127.0.0.1:")
        || host == "[::1]"
        || host.starts_with("[::1]:")
}

fn name(headers: &HeaderMap) -> &'static str {
    if local(headers) {
        "wien_session"
    } else {
        "__Host-wien_session"
    }
}

/// Cookie auth is opt-in with a custom header; there is deliberately no CORS allowance.
/// Origin + Fetch Metadata additionally reject cross-origin requests, including sibling subdomains.
pub(super) fn mode(headers: &HeaderMap) -> Result<bool, Error> {
    let Some(mode) = headers.get("x-wien-session") else {
        return Ok(false);
    };
    let forbidden = || {
        Error::new(
            StatusCode::FORBIDDEN,
            "invalid_session_origin",
            "Open Wien on its own website to sign in.",
        )
    };
    if mode != "cookie" {
        return Err(forbidden());
    }
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(forbidden)?;
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    let site = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok());
    let origin_ok = origin.is_some_and(|value| {
        value == format!("https://{host}") || (local(headers) && value == format!("http://{host}"))
    });
    if origin.is_some() && !origin_ok
        || site.is_some_and(|v| v != "same-origin")
        || !origin_ok && site != Some("same-origin")
    {
        return Err(forbidden());
    }
    Ok(true)
}

pub(super) fn token(headers: &HeaderMap) -> Option<&str> {
    let mut values = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|v| v.trim().split_once('='))
        .filter(|(key, _)| *key == name(headers))
        .map(|(_, value)| value);
    let token = values.next()?;
    if values.next().is_some() {
        return None;
    }
    Some(token)
}

pub(super) fn header(headers: &HeaderMap, token: &str, max_age: u32) -> HeaderValue {
    format!(
        "{}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{}",
        name(headers),
        if local(headers) { "" } else { "; Secure" }
    )
    .parse()
    .expect("session tokens contain only hex digits")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn browser() -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "wien.aydar.media".parse().unwrap());
        h.insert(header::ORIGIN, "https://wien.aydar.media".parse().unwrap());
        h.insert("x-wien-session", "cookie".parse().unwrap());
        h
    }

    #[test]
    fn cookie_requires_explicit_same_origin_request() {
        assert!(!mode(&HeaderMap::new()).unwrap());
        let mut h = browser();
        assert!(mode(&h).unwrap());
        h.insert(header::ORIGIN, "https://other.aydar.media".parse().unwrap());
        assert!(mode(&h).is_err());
        h.remove(header::ORIGIN);
        assert!(mode(&h).is_err());
        h.insert("sec-fetch-site", "same-origin".parse().unwrap());
        assert!(mode(&h).unwrap());
        for site in ["cross-site", "same-site", "none"] {
            h.insert("sec-fetch-site", site.parse().unwrap());
            assert!(mode(&h).is_err());
        }
    }

    #[test]
    fn cookies_are_host_bound_http_only_and_reject_duplicates() {
        let mut h = browser();
        assert_eq!(
            header(&h, "abcd", 30),
            "__Host-wien_session=abcd; Path=/; HttpOnly; SameSite=Strict; Max-Age=30; Secure"
        );
        h.insert(
            header::COOKIE,
            "other=x; __Host-wien_session=abcd".parse().unwrap(),
        );
        assert_eq!(token(&h), Some("abcd"));
        h.append(header::COOKIE, "__Host-wien_session=ef01".parse().unwrap());
        assert_eq!(token(&h), None);
        h.insert(header::HOST, "localhost:5173".parse().unwrap());
        h.insert(header::ORIGIN, "http://localhost:5173".parse().unwrap());
        assert!(mode(&h).unwrap());
        assert_eq!(
            header(&h, "", 0),
            "wien_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
        );
    }
}
