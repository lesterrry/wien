use super::*;
fn config() -> TestConfig {
    TestConfig::new(
        "demo".into(),
        "test-password-one".into(),
        "test-password-two".into(),
        ["tester".into()].into(),
    )
    .unwrap()
}
const ID: &str = "12345678-1234-1234-1234-123456789abc";
#[test]
fn checkout_is_always_test_and_signed_without_exposing_passwords() {
    let url = config().checkout_url(42, ID, 39900, "Плюс");
    let fields: BTreeMap<_, _> = Url::parse(&url)
        .unwrap()
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    assert_eq!(fields["IsTest"], "1");
    assert_eq!(fields["OutSum"], "399.00");
    assert_eq!(
        fields["SignatureValue"],
        hash(&format!(
            "demo:399.00:42:test-password-one:Shp_mode=test:Shp_order={ID}"
        ))
    );
    assert!(!url.contains("password"));
}
#[test]
fn callback_uses_raw_amount_for_signature_and_exact_minor_units() {
    for amount in ["399", "399.00", "399.000000"] {
        let signature = hash(&format!(
            "{amount}:42:test-password-two:Shp_mode=test:Shp_order={ID}"
        ))
        .to_uppercase();
        let fields = vec![
            ("OutSum", amount),
            ("InvId", "42"),
            ("SignatureValue", signature.as_str()),
            ("Shp_mode", "test"),
            ("Shp_order", ID),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect::<Vec<_>>();
        let result = config().verify(fields.clone()).unwrap();
        assert_eq!(result.amount_minor, 39900);
        let mut duplicate = fields.clone();
        duplicate.push(("OutSum".into(), amount.into()));
        assert!(config().verify(duplicate).is_err());
        let mut invalid = fields;
        invalid[2].1 = "a".repeat(64);
        assert!(config().verify(invalid).is_err());
    }
    for invalid in [
        "0",
        "-1",
        "NaN",
        "1e3",
        "1.001",
        "1.000001",
        " 1",
        "1,00",
        "9223372036854775807",
        "1.0000000",
    ] {
        assert!(amount_minor(invalid).is_none(), "{invalid}");
    }
}
