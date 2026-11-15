import type { SubscriptionPlan } from "./account";

export function parsePlan(value: unknown): SubscriptionPlan {
  const invalid = () => new Error("Invalid subscription catalog.");
  if (!value || typeof value !== "object") throw invalid();
  const p = value as Record<string, unknown>;
  if (
    typeof p.id !== "string" ||
    !/^[a-z][a-z0-9_]*$/.test(p.id) ||
    typeof p.name !== "string" ||
    !p.name.trim() ||
    typeof p.description !== "string" ||
    !Array.isArray(p.features) ||
    !p.features.every((f) => typeof f === "string") ||
    typeof p.price_minor !== "number" ||
    !Number.isSafeInteger(p.price_minor) ||
    p.price_minor < 0 ||
    typeof p.currency !== "string" ||
    !/^[A-Z]{3}$/.test(p.currency) ||
    typeof p.currency_minor_units !== "number" ||
    !Number.isInteger(p.currency_minor_units) ||
    p.currency_minor_units < 0 ||
    p.currency_minor_units > 4 ||
    typeof p.billing_period !== "string" ||
    !["none", "month", "year"].includes(p.billing_period) ||
    (p.initial_assist_requests !== null &&
      (typeof p.initial_assist_requests !== "number" ||
        !Number.isSafeInteger(p.initial_assist_requests) ||
        p.initial_assist_requests < 0)) ||
    typeof p.audio_enabled !== "boolean" ||
    typeof p.is_default !== "boolean" ||
    (p.ai_usage_multiplier != null &&
      (typeof p.ai_usage_multiplier !== "number" ||
        !Number.isSafeInteger(p.ai_usage_multiplier) ||
        p.ai_usage_multiplier <= 0)) ||
    (p.name_ru != null && typeof p.name_ru !== "string") ||
    (p.description_ru != null && typeof p.description_ru !== "string") ||
    (p.features_ru != null &&
      (!Array.isArray(p.features_ru) ||
        !p.features_ru.every((item) => typeof item === "string")))
  )
    throw invalid();
  return value as SubscriptionPlan;
}
