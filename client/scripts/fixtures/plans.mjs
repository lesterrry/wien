// Mock API catalog. Production plan data is owned by PostgreSQL.
export const plans = [
  ["free", "Free", 0],
  ["plus", "PLUS", 19900],
  ["pro", "PRO", 69900],
  ["ultra", "ULTRA", 399000],
].map(([id, name, price_minor]) => ({
  id,
  name,
  description:
    id === "free"
      ? "Try Assist."
      : "Unlimited Assist with text and audio attachments.",
  features: [
    id === "free"
      ? "10 text Assist requests"
      : "Unlimited text Assist requests",
  ],
  price_minor,
  currency: "RUB",
  currency_minor_units: 2,
  billing_period: id === "free" ? "none" : "month",
  initial_assist_requests: id === "free" ? 10 : null,
  audio_enabled: id !== "free",
  is_default: id === "free",
}));
