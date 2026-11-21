use super::{Error, Payments};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, Transaction};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use utoipa::ToSchema;

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateOrder {
    pub request_id: String,
    pub plan_id: String,
    pub document_version: String,
    pub price_minor: i64,
    pub request_limit: i32,
    /// Legacy client field; consent is a client-side control and is not stored.
    #[serde(default, rename = "accepted")]
    pub _accepted: bool,
}
#[derive(Serialize, ToSchema)]
pub struct Order {
    pub id: String,
    /// Decimal string, not a JavaScript number.
    pub invoice_id: String,
    pub plan_id: String,
    pub plan_name: String,
    pub price_minor: i64,
    pub currency: String,
    pub request_limit: i32,
    pub document_version: String,
    pub status: String,
    pub is_test: bool,
    pub created_at: String,
    pub paid_at: Option<String>,
    pub period_ends_at: Option<String>,
    pub checkout_url: Option<String>,
}
#[derive(FromRow)]
pub(super) struct Row {
    id: String,
    invoice_id: i64,
    user_id: String,
    merchant_login: String,
    plan_id: String,
    plan_name: String,
    price_minor: i64,
    currency: String,
    request_limit: i32,
    audio_enabled: bool,
    document_version: String,
    status: String,
    is_test: bool,
    created_at: OffsetDateTime,
    paid_at: Option<OffsetDateTime>,
    period_ends_at: Option<OffsetDateTime>,
}
fn date(value: OffsetDateTime) -> String {
    value.format(&Rfc3339).expect("valid database timestamp")
}
impl Row {
    fn view(self, state: &Payments, allowed: bool) -> Order {
        let checkout_url = state
            .config
            .as_ref()
            .filter(|c| {
                allowed
                    && self.status == "pending"
                    && self.is_test == c.is_test()
                    && self.merchant_login == c.merchant_login
            })
            .map(|c| c.checkout_url(self.invoice_id, &self.id, self.price_minor, &self.plan_name));
        Order {
            id: self.id,
            invoice_id: self.invoice_id.to_string(),
            plan_id: self.plan_id,
            plan_name: self.plan_name,
            price_minor: self.price_minor,
            currency: self.currency,
            request_limit: self.request_limit,
            document_version: self.document_version,
            status: self.status,
            is_test: self.is_test,
            created_at: date(self.created_at),
            paid_at: self.paid_at.map(date),
            period_ends_at: self.period_ends_at.map(date),
            checkout_url,
        }
    }
}
// All writers lock subscription before order, including notifications and cancellations.
async fn lock_user(tx: &mut Transaction<'_, Postgres>, user: &str) -> Result<bool, Error> {
    sqlx::query_scalar("SELECT COALESCE(period_ends_at>now(),false) FROM subscriptions WHERE user_id=$1::uuid FOR UPDATE")
        .bind(user).fetch_one(&mut **tx).await.map_err(Into::into)
}
impl Payments {
    pub(super) async fn orders(&self, user: &str) -> Result<Vec<Order>, Error> {
        let allowed = self.allowed(user).await?;
        let rows=sqlx::query_as::<_,Row>("SELECT id::text,invoice_id,user_id::text,merchant_login,plan_id,plan_name,price_minor,currency,request_limit,audio_enabled,document_version,status,is_test,created_at,paid_at,period_ends_at FROM payment_orders WHERE user_id=$1::uuid ORDER BY created_at DESC,id DESC LIMIT 20").bind(user).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|r| r.view(self, allowed)).collect())
    }
    pub(super) async fn order(&self, user: &str, id: &str) -> Result<Order, Error> {
        if !crate::robokassa::valid_id(id) {
            return Err(Error::missing());
        }
        let allowed = self.allowed(user).await?;
        let row = sqlx::query_as::<_, Row>("SELECT id::text,invoice_id,user_id::text,merchant_login,plan_id,plan_name,price_minor,currency,request_limit,audio_enabled,document_version,status,is_test,created_at,paid_at,period_ends_at FROM payment_orders WHERE id=$1::uuid AND user_id=$2::uuid")
        .bind(id)
        .bind(user)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(Error::missing)?;
        Ok(row.view(self, allowed))
    }
    pub(super) async fn create(&self, user: &str, request: CreateOrder) -> Result<Order, Error> {
        let config = self.config.as_ref().ok_or_else(Error::disabled)?;
        if !self.allowed(user).await? {
            return Err(Error::new(
                StatusCode::FORBIDDEN,
                "test_payments_only",
                "Оплата для этого аккаунта пока недоступна.",
            ));
        }
        if !crate::robokassa::valid_id(&request.request_id)
            || request.plan_id.len() > 100
            || request.document_version.len() > 100
        {
            return Err(Error::invalid());
        }
        let mut tx = self.pool.begin().await?;
        let active = lock_user(&mut tx, user).await?;
        let existing = sqlx::query_as::<_, Row>("SELECT id::text,invoice_id,user_id::text,merchant_login,plan_id,plan_name,price_minor,currency,request_limit,audio_enabled,document_version,status,is_test,created_at,paid_at,period_ends_at FROM payment_orders WHERE user_id=$1::uuid AND request_id=$2::uuid")
        .bind(user)
        .bind(&request.request_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(row) = existing {
            if row.plan_id != request.plan_id
                || row.price_minor != request.price_minor
                || row.request_limit != request.request_limit
                || row.document_version != request.document_version
            {
                return Err(Error::conflict(
                    "order_request_conflict",
                    "Повторный запрос содержит другие условия покупки.",
                ));
            }
            return Ok(row.view(self, true));
        }
        if active {
            return Err(Error::conflict(
                "subscription_active",
                "Подписка ещё действует. Новый период можно купить после её окончания.",
            ));
        }
        let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM payment_orders WHERE user_id=$1::uuid AND status='pending')").bind(user).fetch_one(&mut *tx).await?;
        if pending {
            return Err(Error::conflict(
                "order_pending",
                "У вас уже есть незавершённый заказ. Продолжите оплату или отмените его в истории.",
            ));
        }
        let recent:i64=sqlx::query_scalar("SELECT count(*) FROM payment_orders WHERE user_id=$1::uuid AND created_at>now()-interval '1 hour'").bind(user).fetch_one(&mut *tx).await?;
        if recent >= 10 {
            return Err(Error::new(
                StatusCode::TOO_MANY_REQUESTS,
                "payment_rate_limited",
                "Слишком много заказов. Попробуйте через час.",
            ));
        }
        let plan = sqlx::query_as::<_, crate::plans::Plan>(
            "SELECT * FROM plans WHERE id=$1 AND visible AND NOT is_default FOR SHARE",
        )
        .bind(&request.plan_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(Error::invalid)?;
        if plan.currency != "RUB"
            || plan.currency_minor_units != 2
            || plan.billing_period != "month"
            || plan.price_minor <= 0
            || plan.initial_assist_requests.is_none_or(|n| n <= 0)
        {
            return Err(Error::invalid());
        }
        let document_version: String =
            sqlx::query_scalar("SELECT document_version FROM storefront WHERE singleton FOR SHARE")
                .fetch_one(&mut *tx)
                .await?;
        if document_version != request.document_version
            || plan.price_minor != request.price_minor
            || plan.initial_assist_requests != Some(request.request_limit)
        {
            return Err(Error::conflict(
                "payment_terms_changed",
                "Условия тарифа изменились. Откройте тарифы заново и подтвердите актуальные условия.",
            ));
        }
        let row=sqlx::query_as::<_,Row>("INSERT INTO payment_orders(user_id,request_id,merchant_login,is_test,plan_id,plan_name,price_minor,currency,request_limit,audio_enabled,document_version) VALUES($1::uuid,$2::uuid,$3,$10,$4,$5,$6,'RUB',$7,$8,$9) RETURNING id::text,invoice_id,user_id::text,merchant_login,plan_id,plan_name,price_minor,currency,request_limit,audio_enabled,document_version,status,is_test,created_at,paid_at,period_ends_at")
            .bind(user).bind(&request.request_id).bind(&config.merchant_login).bind(&plan.id).bind(plan.name_ru.as_deref().unwrap_or(&plan.name))
            .bind(plan.price_minor).bind(request.request_limit).bind(plan.audio_enabled).bind(&document_version).bind(config.is_test()).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok(row.view(self, true))
    }
    pub(super) async fn cancel(&self, user: &str, id: &str) -> Result<Order, Error> {
        if !crate::robokassa::valid_id(id) {
            return Err(Error::missing());
        }
        let mut tx = self.pool.begin().await?;
        lock_user(&mut tx, user).await?;
        let row = sqlx::query_as::<_, Row>("SELECT id::text,invoice_id,user_id::text,merchant_login,plan_id,plan_name,price_minor,currency,request_limit,audio_enabled,document_version,status,is_test,created_at,paid_at,period_ends_at FROM payment_orders WHERE id=$1::uuid AND user_id=$2::uuid FOR UPDATE")
        .bind(id)
        .bind(user)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(Error::missing)?;
        if row.status == "pending" {
            sqlx::query("UPDATE payment_orders SET status='cancelled' WHERE id=$1::uuid")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        self.order(user, id).await
    }
    pub(super) async fn confirm(
        &self,
        notification: crate::robokassa::Notification,
    ) -> Result<(), Error> {
        let config = self.config.as_ref().ok_or_else(Error::disabled)?;
        let user: Option<String> = sqlx::query_scalar(
            "SELECT user_id::text FROM payment_orders WHERE id=$1::uuid AND invoice_id=$2",
        )
        .bind(&notification.order_id)
        .bind(notification.invoice_id)
        .fetch_optional(&self.pool)
        .await?;
        let user = user.ok_or_else(Error::missing)?;
        let mut tx = self.pool.begin().await?;
        let active = lock_user(&mut tx, &user).await?;
        let row = sqlx::query_as::<_, Row>("SELECT id::text,invoice_id,user_id::text,merchant_login,plan_id,plan_name,price_minor,currency,request_limit,audio_enabled,document_version,status,is_test,created_at,paid_at,period_ends_at FROM payment_orders WHERE id=$1::uuid FOR UPDATE")
        .bind(&notification.order_id)
        .fetch_one(&mut *tx)
        .await?;
        if row.is_test != config.is_test()
            || row.merchant_login != config.merchant_login
            || row.price_minor != notification.amount_minor
            || row.user_id != user
        {
            return Err(Error::invalid());
        }
        if row.status == "paid" || row.status == "paid_review" {
            return Ok(());
        }
        // A late payment for a cancelled order, or an overlapping manual grant, must not erase paid access.
        if row.status == "cancelled" || active {
            sqlx::query(
                "UPDATE payment_orders SET status='paid_review',paid_at=now() WHERE id=$1::uuid",
            )
            .bind(&row.id)
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query("UPDATE subscriptions SET tier=$2,assist_requests_remaining=$3,period_request_limit=$3,period_audio_enabled=$4,payment_order_id=$5::uuid,period_ends_at=((now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC' WHERE user_id=$1::uuid")
                .bind(&user).bind(&row.plan_id).bind(row.request_limit).bind(row.audio_enabled).bind(&row.id).execute(&mut *tx).await?;
            sqlx::query("UPDATE payment_orders SET status='paid',paid_at=now(),period_ends_at=(SELECT period_ends_at FROM subscriptions WHERE user_id=$2::uuid) WHERE id=$1::uuid")
                .bind(&row.id).bind(&user).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }
}
