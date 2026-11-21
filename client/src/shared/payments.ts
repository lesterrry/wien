export interface PaymentConfig {
  mode: "disabled" | "test" | "live";
}
export interface PaymentRequest {
  request_id: string;
  plan_id: string;
  document_version: string;
  price_minor: number;
  request_limit: number;
}
export interface PaymentOrder {
  id: string;
  invoice_id: string;
  plan_id: string;
  plan_name: string;
  price_minor: number;
  currency: "RUB";
  request_limit: number;
  document_version: string;
  status: "pending" | "cancelled" | "paid" | "paid_review";
  is_test: boolean;
  created_at: string;
  paid_at: string | null;
  period_ends_at: string | null;
  checkout_url: string | null;
}
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export function paymentId(value: string): string {
  if (!uuid.test(value)) throw new Error("Некорректный номер заказа.");
  return value;
}
export function parsePaymentConfig(value: unknown): PaymentConfig {
  if (
    !value ||
    typeof value !== "object" ||
    !("mode" in value) ||
    (value.mode !== "disabled" &&
      value.mode !== "test" &&
      value.mode !== "live")
  )
    throw new Error("Не удалось проверить доступность оплаты.");
  return { mode: value.mode };
}
export function parsePaymentOrder(value: unknown): PaymentOrder {
  if (!value || typeof value !== "object")
    throw new Error("Некорректный ответ сервера оплаты.");
  const row = value as Record<string, unknown>;
  const text = (key: string) =>
    typeof row[key] === "string" && (row[key] as string).length > 0;
  const date = (v: unknown) =>
    typeof v === "string" && Number.isFinite(Date.parse(v));
  const integer = (key: string) =>
    Number.isSafeInteger(row[key]) && (row[key] as number) > 0;
  if (
    !text("id") ||
    !uuid.test(row.id as string) ||
    !text("invoice_id") ||
    !/^[1-9][0-9]{0,18}$/.test(row.invoice_id as string) ||
    !text("plan_id") ||
    !text("plan_name") ||
    !text("document_version") ||
    !integer("price_minor") ||
    !integer("request_limit") ||
    row.currency !== "RUB" ||
    typeof row.is_test !== "boolean" ||
    !["pending", "cancelled", "paid", "paid_review"].includes(
      row.status as string,
    ) ||
    !date(row.created_at) ||
    (row.paid_at !== null && !date(row.paid_at)) ||
    (row.period_ends_at !== null && !date(row.period_ends_at)) ||
    (row.status === "paid" || row.status === "paid_review") !==
      (row.paid_at !== null) ||
    (row.status === "paid") !== (row.period_ends_at !== null)
  )
    throw new Error("Некорректный ответ сервера оплаты.");
  if (row.checkout_url !== null) {
    if (typeof row.checkout_url !== "string" || row.status !== "pending")
      throw new Error("Некорректная ссылка оплаты.");
    const url = new URL(row.checkout_url);
    if (
      url.origin !== "https://auth.robokassa.ru" ||
      url.pathname !== "/Merchant/Index.aspx" ||
      url.username ||
      url.password ||
      url.hash ||
      (row.is_test
        ? url.searchParams.get("IsTest") !== "1"
        : url.searchParams.has("IsTest")) ||
      url.searchParams.get("Shp_order") !== row.id ||
      url.searchParams.get("Shp_mode") !== (row.is_test ? "test" : "live") ||
      url.searchParams.get("InvId") !== row.invoice_id ||
      ["IsTest", "Shp_mode", "Shp_order", "InvId"].some(
        (key) => url.searchParams.getAll(key).length > 1,
      )
    )
      throw new Error("Некорректная ссылка оплаты.");
  }
  return value as PaymentOrder;
}
