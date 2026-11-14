export interface Storefront {
  seller_name: string;
  seller_inn: string;
  seller_city: string;
  support_email: string;
  support_phone: string | null;
  accounts_location: string;
  document_version: string;
  documents_published: boolean;
  renewal_mode: "manual";
  ai_usage_policy: string;
}

export function parseStorefront(data: unknown): Storefront {
  if (!data || typeof data !== "object") throw new Error("Invalid storefront");
  const value = data as Record<string, unknown>;
  const strings = [
    "seller_name",
    "seller_inn",
    "seller_city",
    "support_email",
    "accounts_location",
    "document_version",
    "ai_usage_policy",
  ];
  if (
    strings.some((key) => typeof value[key] !== "string" || !value[key]) ||
    typeof value.documents_published !== "boolean" ||
    value.renewal_mode !== "manual" ||
    (value.support_phone !== null && typeof value.support_phone !== "string") ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value.support_email)) ||
    !/^\d{12}$/.test(String(value.seller_inn))
  )
    throw new Error("Invalid storefront");
  return data as Storefront;
}
