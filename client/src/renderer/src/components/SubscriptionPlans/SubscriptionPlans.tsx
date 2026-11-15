import { FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SubscriptionPlan } from "../../../../shared/account";
import type { Storefront } from "../../../../shared/storefront";
import { formatLocale, getLocale, t, useLocale } from "../../i18n";
import { Dialog } from "../Dialog/Dialog";
import tabStyles from "../FileTabs/FileTabs.module.css";
import {
  Offer,
  Privacy,
  PurchaseTerms,
  RefundTerms,
  Seller,
} from "./Documents";
import { Payments } from "./Payments";
import styles from "./SubscriptionPlans.module.css";

export type BillingTab = "plans" | "offer" | "privacy" | "payments";
type Tab = BillingTab;
const names: Record<Tab, string> = {
  plans: "Тарифы",
  offer: "Условия покупки",
  privacy: "Политика данных",
  payments: "Платежи",
};
const name = (plan: SubscriptionPlan) =>
  getLocale() === "ru" ? plan.name_ru || plan.name : plan.name;
const price = (plan: SubscriptionPlan) =>
  new Intl.NumberFormat(formatLocale(), {
    style: "currency",
    currency: plan.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: plan.currency_minor_units,
  }).format(plan.price_minor / 10 ** plan.currency_minor_units);
function allowance(plan: SubscriptionPlan) {
  if (plan.initial_assist_requests === null)
    return t("Без ограничения запросов");
  return `${plan.initial_assist_requests.toLocaleString(formatLocale())} ${t("requests")} ${plan.billing_period === "month" ? t("в месяц") : plan.billing_period === "year" ? t("в год") : t("однократно")}`;
}

export function SubscriptionPlans({
  exhausted,
  audio = false,
  currentPlanId,
  userId,
  returnOrderId,
  onSignIn,
  onPaid,
  initialTab = "plans",
  onClose,
}: {
  exhausted: boolean;
  audio?: boolean;
  currentPlanId?: string;
  userId?: string;
  returnOrderId?: string;
  onSignIn: () => void;
  onPaid: () => Promise<unknown>;
  initialTab?: Tab;
  onClose: () => void;
}) {
  useLocale();
  const [tab, setTab] = useState<Tab>(initialTab);
  const selectedTab = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keep the selected tab visible after navigation and resizing.
  useEffect(() => {
    const reveal = () =>
      selectedTab.current?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    reveal();
    window.addEventListener("resize", reveal);
    return () => window.removeEventListener("resize", reveal);
  }, [tab]);
  const [store, setStore] = useState<Storefront | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries the public data request.
  useEffect(() => {
    let active = true;
    setError(false);
    setStore(null);
    void window.workspace.storefront().then(
      (details) => {
        if (active) setStore(details);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  const plans = store?.plans;
  const plan = plans?.find((item) => item.id === selected);
  function navigate(next: Tab) {
    setTab(next);
  }
  return (
    <Dialog title={t("Тарифы")} onClose={onClose} className={styles.dialog}>
      <div
        className={styles.tabs}
        role="tablist"
        aria-label={t("Тарифы и документы")}
        onKeyDown={(event) => {
          const items = Object.keys(names) as Tab[];
          const index = items.indexOf(tab);
          const next =
            event.key === "ArrowRight"
              ? (index + 1) % items.length
              : event.key === "ArrowLeft"
                ? (index + items.length - 1) % items.length
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : -1;
          if (next < 0) return;
          event.preventDefault();
          navigate(items[next]);
          const button =
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="tab"]',
            )[next];
          button?.focus();
          button?.scrollIntoView({ block: "nearest", inline: "nearest" });
        }}
      >
        {(Object.keys(names) as Tab[]).map((item) => (
          <div
            key={item}
            role="presentation"
            className={`${styles.tab} ${tab === item ? tabStyles.active : ""}`}
          >
            <button
              type="button"
              role="tab"
              ref={tab === item ? selectedTab : undefined}
              id={`billing-tab-${item}`}
              aria-selected={tab === item}
              aria-controls="billing-panel"
              tabIndex={tab === item ? 0 : -1}
              className={tabStyles.fileTabSelect}
              onClick={() => navigate(item)}
            >
              <FileText size={13} aria-hidden="true" />
              <span className={tabStyles.fileTabName}>{t(names[item])}</span>
            </button>
          </div>
        ))}
      </div>
      <div
        className={styles.content}
        id="billing-panel"
        role="tabpanel"
        aria-labelledby={`billing-tab-${tab}`}
      >
        {error ? (
          <div role="alert">
            <p>{t("Не удалось загрузить тарифы.")}</p>
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t("Попробовать снова")}
            </button>
          </div>
        ) : !plans || !store ? (
          <p role="status">{t("Загружаем тарифы…")}</p>
        ) : tab === "payments" ? (
          <Payments
            config={store.payments}
            key={userId || "guest"}
            userId={userId}
            documentVersion={store.terms.document_version}
            returnOrderId={returnOrderId}
            supportEmail={store.seller.support_email}
            onSignIn={onSignIn}
            onPaid={onPaid}
          />
        ) : tab === "offer" ? (
          <Offer store={store} onNavigate={navigate} />
        ) : tab === "privacy" ? (
          <Privacy store={store} />
        ) : plan ? (
          <section
            className={styles.checkout}
            aria-label={t("Условия покупки")}
          >
            <button
              type="button"
              className={styles.back}
              onClick={() => {
                setSelected(null);
                setAccepted(false);
              }}
            >
              {t("← Все тарифы")}
            </button>
            <h3>{name(plan)}</h3>
            <p className={styles.price}>
              {price(plan)}{" "}
              <span>
                / {plan.billing_period === "year" ? t("год") : t("месяц")}
              </span>
            </p>
            <p className={styles.allowance}>{allowance(plan)}</p>
            <p>
              {getLocale() === "ru"
                ? plan.description_ru || plan.description
                : plan.description}
            </p>
            <PurchaseTerms period={plan.billing_period} />
            <p>{store.terms.ai_usage_policy}</p>
            <RefundTerms store={store} />
            <label className={styles.consent}>
              <input
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />
              <span>
                {t("Я ознакомился с")}{" "}
                <button type="button" onClick={() => navigate("offer")}>
                  {t("условиями покупки и возврата")}
                </button>{" "}
                {t("и")}{" "}
                <button type="button" onClick={() => navigate("privacy")}>
                  {t("политикой данных")}
                </button>
                .
              </span>
            </label>
            <Payments
              config={store.payments}
              key={`${userId}:${plan.id}:${plan.price_minor}:${plan.initial_assist_requests}:${store.terms.document_version}`}
              userId={userId}
              plan={plan}
              documentVersion={store.terms.document_version}
              accepted={accepted}
              supportEmail={store.seller.support_email}
              onSignIn={onSignIn}
              onPaid={onPaid}
            />
          </section>
        ) : (
          <>
            <p>
              {t(
                "Wien — AI-first редактор музыки. Создавайте и изменяйте Strudel-код по текстовому запросу, анализируйте готовое аудио и экспортируйте свою работу.",
              )}
            </p>
            <p className={styles.intro}>
              {exhausted
                ? t("Вы использовали доступные запросы ИИ.")
                : t("Выберите количество запросов для вашей музыки.")}{" "}
              {t("Один месяц, продление вручную.")}
            </p>
            {audio && <p>{t("Выберите тариф с аудиовложениями.")}</p>}
            {plans.length === 0 ? (
              <p role="status">{t("Тарифы пока недоступны.")}</p>
            ) : (
              <div className={styles.plans}>
                {plans.map((item) => (
                  <section
                    className={styles.plan}
                    key={item.id}
                    aria-label={t("Тариф {p0}", { p0: name(item) })}
                  >
                    <h3>{name(item)}</h3>
                    <div className={styles.price}>
                      {price(item)}
                      {item.billing_period !== "none" && (
                        <span>
                          /{" "}
                          {item.billing_period === "month"
                            ? t("месяц")
                            : t("год")}
                        </span>
                      )}
                    </div>
                    <p className={styles.allowance}>{allowance(item)}</p>
                    <p>
                      {getLocale() === "ru"
                        ? item.description_ru || item.description
                        : item.description}
                    </p>
                    <ul>
                      {[
                        ...new Set(
                          getLocale() === "ru"
                            ? (item.features_ru ?? item.features)
                            : item.features,
                        ),
                      ].map((feature) => (
                        <li key={feature}>{feature}</li>
                      ))}
                    </ul>
                    {item.id === currentPlanId && (
                      <p className={styles.current}>{t("Текущий тариф")}</p>
                    )}
                    <button
                      type="button"
                      disabled={item.is_default}
                      onClick={() => {
                        setSelected(item.id);
                        setAccepted(false);
                      }}
                    >
                      {item.is_default
                        ? t("Включено")
                        : t("Посмотреть условия")}
                    </button>
                  </section>
                ))}
              </div>
            )}
            <p className={styles.note}>{store.terms.ai_usage_policy}</p>
          </>
        )}
        {store && (
          <footer className={styles.footer}>
            <Seller store={store} />
          </footer>
        )}
      </div>
    </Dialog>
  );
}
