use super::*;
fn config() -> Config {
    Config::new(
        Mode::Test,
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

fn live_config() -> Config {
    Config::new(
        Mode::Live,
        "demo".into(),
        "live-password-one".into(),
        "live-password-two".into(),
        Default::default(),
    )
    .unwrap()
}

#[test]
fn live_checkout_signs_encoded_receipt_and_omits_test_flag() {
    let url = live_config().checkout_url(42, ID, 39999, "Плюс & \"музыка\"");
    let fields: BTreeMap<_, _> = Url::parse(&url)
        .unwrap()
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    assert!(!fields.contains_key("IsTest"));
    assert_eq!(fields["Shp_mode"], "live");
    assert_eq!(fields["OutSum"], "399.99");
    let encoded = &fields["Receipt"];
    assert!(encoded.starts_with("%7B"));
    let decoded = url::form_urlencoded::parse(format!("receipt={encoded}").as_bytes())
        .next()
        .unwrap()
        .1
        .into_owned();
    assert!(decoded.contains("\"sum\":399.99"));
    let receipt: serde_json::Value = serde_json::from_str(&decoded).unwrap();
    assert_eq!(
        receipt["items"][0]["name"],
        "Wien: Плюс & \"музыка\", один месяц"
    );
    assert_eq!(receipt["items"][0]["tax"], "none");
    assert_eq!(
        fields["SignatureValue"],
        hash(&format!(
            "demo:399.99:42:{encoded}:live-password-one:Shp_mode=live:Shp_order={ID}"
        ))
    );
    assert!(!url.contains("password"));
}

#[test]
fn callbacks_cannot_cross_modes_or_use_test_secrets_for_live() {
    for (mode, password, live_ok, test_ok) in [
        ("live", "live-password-two", true, false),
        ("live", "test-password-two", false, false),
        ("test", "test-password-two", false, true),
        ("test", "live-password-two", false, false),
    ] {
        let signature = hash(&format!(
            "399.000000:42:{password}:Shp_mode={mode}:Shp_order={ID}"
        ));
        let fields = vec![
            ("OutSum", "399.000000"),
            ("InvId", "42"),
            ("SignatureValue", signature.as_str()),
            ("Shp_mode", mode),
            ("Shp_order", ID),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect::<Vec<_>>();
        assert_eq!(live_config().verify(fields.clone()).is_ok(), live_ok);
        assert_eq!(config().verify(fields).is_ok(), test_ok);
    }
}
