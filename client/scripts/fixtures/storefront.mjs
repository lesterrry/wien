import { plans } from "./plans.mjs";

export const storefront = {
  plans,
  payments: { mode: "disabled" },
  seller: {
    name: "Тестовый Продавец",
    inn: "123456789012",
    city: "Москва",
    support_email: "support@example.com",
    support_phone: null,
  },
  terms: {
    accounts_location: "Российская Федерация",
    document_version: "2026-11-15.1",
    documents_published: true,
    renewal_mode: "manual",
    ai_usage_policy:
      "Один успешный запрос, включая аудио, расходует один запрос из общего лимита. Ошибки не списываются. Продление вручную.",
  },
};
