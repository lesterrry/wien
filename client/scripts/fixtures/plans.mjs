// Mock API catalog. Production plan data is owned by PostgreSQL.
export const plans = [
  ["free", "Free", 0],
  ["plus", "PLUS", 39900],
  ["pro", "PRO", 89900],
  ["ultra", "ULTRA", 599000],
].map(([id, name, price_minor]) => ({
  id,
  name,
  description:
    id === "free"
      ? "Try Assist."
      : "AI requests with text and audio attachments.",
  features: [
    id === "free"
      ? "10 text Assist requests"
      : "Text and audio share one request allowance",
  ],
  price_minor,
  currency: "RUB",
  currency_minor_units: 2,
  billing_period: id === "free" ? "none" : "month",
  initial_assist_requests: { free: 10, plus: 500, pro: 2500, ultra: 5000 }[id],
  audio_enabled: id !== "free",
  is_default: id === "free",
}));
