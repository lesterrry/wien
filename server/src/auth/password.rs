use argon2::{
    Argon2,
    password_hash::{PasswordHasher, PasswordVerifier, phc::PasswordHash},
};

pub fn valid(value: &str) -> bool {
    (12..=128).contains(&value.chars().count()) && value.len() <= 512
}

pub fn hash(password: &str) -> Result<String, super::Error> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .map_err(|_| super::Error::internal())
}

pub fn verify(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|hash| {
        Argon2::default()
            .verify_password(password.as_bytes(), &hash)
            .is_ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn passwords_are_salted_and_verified() {
        let password = "a long test password";
        let hash1 = hash(password).unwrap();
        assert!(hash1.starts_with("$argon2id$"));
        assert_ne!(hash1, hash(password).unwrap());
        assert!(verify(password, &hash1));
        assert!(!verify("incorrect password", &hash1));
        assert!(!verify(password, "broken hash"));
        assert!(!valid("short"));
        assert!(!valid(&"x".repeat(129)));
    }
}
