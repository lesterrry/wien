use super::{
    Error, Payments,
    orders::{CreateOrder, Order},
};
use axum::{
    Form, Json, Router,
    extract::{
        DefaultBodyLimit, Path, Query, Request, State,
        rejection::{FormRejection, JsonRejection},
    },
    http::{HeaderMap, header},
    middleware::{self, Next},
    response::{Redirect, Response},
};
use utoipa_axum::{router::OpenApiRouter, routes};

fn routes() -> (Router<Payments>, utoipa::openapi::OpenApi) {
    OpenApiRouter::new()
        .routes(routes!(create_order, payment_orders))
        .routes(routes!(payment_order))
        .routes(routes!(cancel_order))
        .routes(routes!(robokassa_result))
        .routes(routes!(payment_success))
        .routes(routes!(payment_fail))
        .split_for_parts()
}
pub fn openapi() -> utoipa::openapi::OpenApi {
    routes().1
}
pub fn router(state: Payments) -> Router {
    routes()
        .0
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(middleware::from_fn(no_store))
        .with_state(state)
}
async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
#[utoipa::path(post,path="/v1/payments/orders",request_body(content=CreateOrder,example=json!({"request_id":"00000000-0000-4000-8000-000000000001","plan_id":"plus","price_minor":39900,"request_limit":500,"document_version":"copy-current-version-from-v1-storefront"})),responses((status=200,body=Order),(status=400,body=Error),(status=401,body=Error),(status=403,body=Error),(status=409,body=Error),(status=503,body=Error)),security(("session"=[]),("browser_session"=[])))]
async fn create_order(
    State(state): State<Payments>,
    headers: HeaderMap,
    body: Result<Json<CreateOrder>, JsonRejection>,
) -> Result<Json<Order>, Error> {
    let user = crate::auth::authenticate(&state.pool, &headers).await?;
    Ok(Json(
        state
            .create(&user, body.map_err(|_| Error::invalid())?.0)
            .await?,
    ))
}
#[utoipa::path(get,path="/v1/payments/orders",responses((status=200,body=Vec<Order>),(status=401,body=Error)),security(("session"=[]),("browser_session"=[])))]
async fn payment_orders(
    State(state): State<Payments>,
    headers: HeaderMap,
) -> Result<Json<Vec<Order>>, Error> {
    let user = crate::auth::authenticate(&state.pool, &headers).await?;
    Ok(Json(state.orders(&user).await?))
}
#[utoipa::path(get,path="/v1/payments/orders/{id}",params(("id"=String,Path,description="Order UUID")),responses((status=200,body=Order),(status=404,body=Error)),security(("session"=[]),("browser_session"=[])))]
async fn payment_order(
    State(state): State<Payments>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Order>, Error> {
    let user = crate::auth::authenticate(&state.pool, &headers).await?;
    Ok(Json(state.order(&user, &id).await?))
}
#[utoipa::path(post,path="/v1/payments/orders/{id}/cancel",params(("id"=String,Path)),responses((status=200,body=Order),(status=404,body=Error)),security(("session"=[]),("browser_session"=[])))]
async fn cancel_order(
    State(state): State<Payments>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Order>, Error> {
    let user = crate::auth::authenticate(&state.pool, &headers).await?;
    Ok(Json(state.cancel(&user, &id).await?))
}
/// Configure ResultURL as POST. Form values are checked for duplicates before signature verification.
#[utoipa::path(post,path="/v1/payments/robokassa/result",request_body(content=String,content_type="application/x-www-form-urlencoded",example="OutSum=399.00&InvId=1&Shp_mode=test&Shp_order=00000000-0000-4000-8000-000000000001&SignatureValue=replace-with-sha256-test-password2-signature"),responses((status=200,body=String,content_type="text/plain"),(status=400,body=Error),(status=503,body=Error)))]
async fn robokassa_result(
    State(state): State<Payments>,
    form: Result<Form<Vec<(String, String)>>, FormRejection>,
) -> Result<String, Error> {
    let config = state.config.as_ref().ok_or_else(Error::disabled)?;
    let notification = config
        .verify(form.map_err(|_| Error::invalid())?.0)
        .map_err(|_| Error::invalid())?;
    let invoice = notification.invoice_id;
    state.confirm(notification).await?;
    Ok(format!("OK{invoice}"))
}
// Return URLs are navigation only. Never accept browser parameters as proof of payment.
fn returned(fields: Vec<(String, String)>) -> Redirect {
    let ids = fields
        .iter()
        .filter(|(key, _)| key == "Shp_order")
        .collect::<Vec<_>>();
    if ids.len() == 1 && crate::robokassa::valid_id(&ids[0].1) {
        Redirect::to(&format!("/?payment={}", ids[0].1))
    } else {
        Redirect::to("/?billing=1")
    }
}
#[utoipa::path(get,path="/v1/payments/robokassa/success",responses((status=303,description="Return to editor; status is verified through the authenticated order API")))]
async fn payment_success(Query(fields): Query<Vec<(String, String)>>) -> Redirect {
    returned(fields)
}
#[utoipa::path(get,path="/v1/payments/robokassa/fail",responses((status=303,description="Return to editor; a failed/cancelled browser return never changes the order")))]
async fn payment_fail(Query(fields): Query<Vec<(String, String)>>) -> Redirect {
    returned(fields)
}
