//! Robokassa protocol only; order ownership and fulfillment live in payments.
use crate::payments::Mode;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use subtle::ConstantTimeEq;
use url::Url;

pub struct Config {
    pub mode: Mode,
    pub merchant_login: String,
    password1: String,
    password2: String,
    pub test_users: HashSet<String>,
}
impl Config {
    pub fn new(
        mode: Mode,
        merchant_login: String,
        password1: String,
        password2: String,
        test_users: HashSet<String>,
    ) -> Result<Self, &'static str> {
        if mode == Mode::Disabled
            || merchant_login.is_empty()
            || merchant_login.len() > 100
            || !merchant_login
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || password1.len() < 8
            || password2.len() < 8
            || password1 == password2
            || [&password1, &password2]
                .iter()
                .any(|s| s.len() > 256 || s.contains(':') || s.chars().any(char::is_control))
            || (mode == Mode::Test && test_users.is_empty())
            || test_users.iter().any(|s| !crate::users::valid_username(s))
        {
            return Err(
                "Invalid Robokassa configuration. Set an enabled mode, merchant login, distinct passwords (8+ characters), and test usernames in test mode.",
            );
        }
        Ok(Self {
            mode,
            merchant_login,
            password1,
            password2,
            test_users,
        })
    }
    pub fn is_test(&self) -> bool {
        self.mode == Mode::Test
    }
    fn mode_name(&self) -> &'static str {
        if self.is_test() { "test" } else { "live" }
    }
    pub fn checkout_url(&self, invoice: i64, id: &str, amount_minor: i64, name: &str) -> String {
        let amount = format!("{}.{:02}", amount_minor / 100, amount_minor % 100);
        let invoice = invoice.to_string();
        let mode = self.mode_name();
        let description = format!("Wien: {name}, один месяц");
        // Robokassa signs the URL-encoded Receipt, then URL-encodes it again in the query.
        // Embed the decimal amount directly, without converting money through f64.
        let receipt = (!self.is_test()).then(|| {
            let name = serde_json::to_string(&description.chars().take(128).collect::<String>())
                .expect("receipt name");
            let receipt = format!(
                r#"{{"items":[{{"name":{name},"quantity":1,"sum":{amount},"tax":"none"}}]}}"#
            );
            url::form_urlencoded::byte_serialize(receipt.as_bytes())
                .collect::<String>()
                .replace('+', "%20")
        });
        let receipt_part = receipt
            .as_ref()
            .map(|r| format!(":{r}"))
            .unwrap_or_default();
        let signature = hash(&format!(
            "{}:{amount}:{invoice}{receipt_part}:{}:Shp_mode={mode}:Shp_order={id}",
            self.merchant_login, self.password1
        ));
        let mut url =
            Url::parse("https://auth.robokassa.ru/Merchant/Index.aspx").expect("constant URL");
        url.query_pairs_mut().extend_pairs([
            ("MerchantLogin", self.merchant_login.as_str()),
            ("OutSum", amount.as_str()),
            ("InvId", invoice.as_str()),
            ("Description", description.as_str()),
            ("Culture", "ru"),
            ("SignatureValue", signature.as_str()),
            ("Shp_mode", mode),
            ("Shp_order", id),
        ]);
        if self.is_test() {
            url.query_pairs_mut().append_pair("IsTest", "1");
        }
        if let Some(receipt) = receipt {
            url.query_pairs_mut().append_pair("Receipt", &receipt);
        }
        url.to_string()
    }
    pub fn verify(&self, fields: Vec<(String, String)>) -> Result<Notification, &'static str> {
        let mut values = BTreeMap::new();
        for (key, value) in fields {
            if values.insert(key, value).is_some() {
                return Err("Duplicate callback field");
            }
        }
        let get = |key: &str| {
            values
                .get(key)
                .map(String::as_str)
                .ok_or("Missing callback field")
        };
        if values
            .keys()
            .any(|k| k.starts_with("Shp_") && k != "Shp_mode" && k != "Shp_order")
            || get("Shp_mode")? != self.mode_name()
        {
            return Err("Unexpected callback parameters");
        }
        let id = get("Shp_order")?;
        if !valid_id(id) {
            return Err("Invalid order ID");
        }
        let amount = get("OutSum")?;
        let amount_minor = amount_minor(amount).ok_or("Invalid amount")?;
        let invoice = get("InvId")?;
        if invoice.is_empty() || invoice.len() > 19 || !invoice.bytes().all(|c| c.is_ascii_digit())
        {
            return Err("Invalid invoice");
        }
        let invoice_id = invoice
            .parse::<i64>()
            .ok()
            .filter(|v| *v > 0)
            .ok_or("Invalid invoice")?;
        let signature = get("SignatureValue")?;
        let mode = self.mode_name();
        let expected = hash(&format!(
            "{amount}:{invoice}:{}:Shp_mode={mode}:Shp_order={id}",
            self.password2
        ));
        if signature.len() != 64
            || !signature.bytes().all(|c| c.is_ascii_hexdigit())
            || !bool::from(
                expected
                    .as_bytes()
                    .ct_eq(signature.to_ascii_lowercase().as_bytes()),
            )
        {
            return Err("Invalid signature");
        }
        Ok(Notification {
            invoice_id,
            order_id: id.into(),
            amount_minor,
        })
    }
}
pub struct Notification {
    pub invoice_id: i64,
    pub order_id: String,
    pub amount_minor: i64,
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn amount_minor(value: &str) -> Option<i64> {
    if value.len() > 24 {
        return None;
    }
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|c| c.is_ascii_digit())
        || fraction.len() > 6
        || !fraction.bytes().all(|c| c.is_ascii_digit())
        || fraction.bytes().skip(2).any(|c| c != b'0')
    {
        return None;
    }
    let mut cents = fraction.bytes().take(2).map(|c| (c - b'0') as i64);
    let decimal = cents.next().unwrap_or(0) * 10 + cents.next().unwrap_or(0);
    whole
        .parse::<i64>()
        .ok()?
        .checked_mul(100)?
        .checked_add(decimal)
        .filter(|n| *n > 0)
}
#[cfg(test)]
mod tests;
