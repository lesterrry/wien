use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tonic::{Request, Status, service::Interceptor};

// Intentionally neither Debug nor Serialize: no secret or digest is logged.
#[derive(Clone)]
pub(crate) struct BearerAuth {
    digest: Option<[u8; 32]>,
}
impl BearerAuth {
    pub(crate) fn new(token: Option<&str>) -> Self {
        Self {
            digest: token.map(|token| Sha256::digest(token.as_bytes()).into()),
        }
    }
}
impl Interceptor for BearerAuth {
    fn call(&mut self, request: Request<()>) -> Result<Request<()>, Status> {
        if let Some(expected) = self.digest {
            let token = request
                .metadata()
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
                .filter(|value| !value.is_empty())
                .ok_or_else(|| Status::unauthenticated("bearer authentication required"))?;
            let actual: [u8; 32] = Sha256::digest(token.as_bytes()).into();
            if !bool::from(expected.ct_eq(&actual)) {
                return Err(Status::unauthenticated("bearer authentication required"));
            }
        }
        Ok(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn optional_and_required_authentication() {
        assert!(BearerAuth::new(None).call(Request::new(())).is_ok());
        for value in [
            None,
            Some("Bearer wrong"),
            Some("Basic correct"),
            Some("Bearer "),
        ] {
            let mut request = Request::new(());
            if let Some(value) = value {
                request
                    .metadata_mut()
                    .insert("authorization", value.parse().unwrap());
            }
            assert_eq!(
                BearerAuth::new(Some("correct"))
                    .call(request)
                    .unwrap_err()
                    .code(),
                tonic::Code::Unauthenticated
            );
        }
        let mut request = Request::new(());
        request
            .metadata_mut()
            .insert("authorization", "Bearer correct".parse().unwrap());
        assert!(BearerAuth::new(Some("correct")).call(request).is_ok());
    }
}
