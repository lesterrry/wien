import type { SubscriptionPlan } from "./account";
import { type PaymentConfig, parsePaymentConfig } from "./payments";
import { parsePlan } from "./plans";

export interface Storefront {
  plans: SubscriptionPlan[];
  seller: {
    name: string;
    inn: string;
    city: string;
    support_email: string;
    support_phone: string | null;
  };
  terms: {
    accounts_location: string;
    document_version: string;
    documents_published: boolean;
    renewal_mode: "manual";
    ai_usage_policy: string;
  };
  payments: PaymentConfig;
}
export function parseStorefront(data: unknown): Storefront {
  const invalid = () => new Error("Invalid storefront");
  if (!data || typeof data !== "object") throw invalid();
  const value = data as Record<string, unknown>;
  if (
    !value.seller ||
    typeof value.seller !== "object" ||
    !value.terms ||
    typeof value.terms !== "object"
  )
    throw invalid();
  const seller = value.seller as Record<string, unknown>;
  const terms = value.terms as Record<string, unknown>;
  if (
    ["name", "inn", "city", "support_email"].some(
      (key) => typeof seller[key] !== "string" || !seller[key],
    ) ||
    ["accounts_location", "document_version", "ai_usage_policy"].some(
      (key) => typeof terms[key] !== "string" || !terms[key],
    ) ||
    typeof terms.documents_published !== "boolean" ||
    terms.renewal_mode !== "manual" ||
    (seller.support_phone !== null &&
      typeof seller.support_phone !== "string") ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(seller.support_email)) ||
    !/^\d{12}$/.test(String(seller.inn))
  )
    throw invalid();
  if (!Array.isArray(value.plans))
    throw new Error("Invalid subscription catalog.");
  const plans = value.plans.map(parsePlan);
  if (new Set(plans.map((plan) => plan.id)).size !== plans.length)
    throw new Error("Invalid subscription catalog.");
  return {
    plans,
    seller: seller as Storefront["seller"],
    terms: terms as Storefront["terms"],
    payments: parsePaymentConfig(value.payments),
  };
}
