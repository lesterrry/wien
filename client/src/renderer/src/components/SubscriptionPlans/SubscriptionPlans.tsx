import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import type { SubscriptionPlan } from "../../../../shared/account";
import type { Storefront } from "../../../../shared/storefront";
import { Dialog } from "../Dialog/Dialog";
import tabStyles from "../FileTabs/FileTabs.module.css";
import {
  Offer,
  Privacy,
  PurchaseTerms,
  RefundTerms,
  Seller,
} from "./Documents";
import styles from "./SubscriptionPlans.module.css";

type Tab = "plans" | "offer" | "privacy";
const names: Record<Tab, string> = {
  plans: "Тарифы",
  offer: "Условия покупки",
  privacy: "Политика данных",
};
const name = (plan: SubscriptionPlan) => plan.name_ru || plan.name;
const price = (plan: SubscriptionPlan) =>
  new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: plan.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: plan.currency_minor_units,
  }).format(plan.price_minor / 10 ** plan.currency_minor_units);
function allowance(plan: SubscriptionPlan) {
  if (plan.initial_assist_requests === null) return "Без ограничения запросов";
  return `${plan.initial_assist_requests.toLocaleString("ru-RU")} запросов ${plan.billing_period === "month" ? "в месяц" : plan.billing_period === "year" ? "в год" : "однократно"}`;
}

export function SubscriptionPlans({
  exhausted,
  audio = false,
  currentPlanId,
  initialTab = "plans",
  onClose,
}: {
  exhausted: boolean;
  audio?: boolean;
  currentPlanId?: string;
  initialTab?: Tab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [plans, setPlans] = useState<SubscriptionPlan[] | null>(null);
  const [store, setStore] = useState<Storefront | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries the public data request.
  useEffect(() => {
    let active = true;
    setError(false);
    setPlans(null);
    void Promise.all([
      window.workspace.subscriptionPlans(),
      window.workspace.storefront(),
    ]).then(
      ([catalog, details]) => {
        if (active) {
          setPlans(catalog);
          setStore(details);
        }
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  const plan = plans?.find((item) => item.id === selected);
  function navigate(next: Tab) {
    setTab(next);
  }
  return (
    <Dialog title="Тарифы" onClose={onClose} className={styles.dialog}>
      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Тарифы и документы"
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
              id={`billing-tab-${item}`}
              aria-selected={tab === item}
              aria-controls="billing-panel"
              tabIndex={tab === item ? 0 : -1}
              className={tabStyles.fileTabSelect}
              onClick={() => navigate(item)}
            >
              <FileText size={13} aria-hidden="true" />
              <span className={tabStyles.fileTabName}>{names[item]}</span>
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
            <p>Не удалось загрузить тарифы.</p>
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Попробовать снова
            </button>
          </div>
        ) : !plans || !store ? (
          <p role="status">Загружаем тарифы…</p>
        ) : tab === "offer" ? (
          <Offer store={store} onNavigate={navigate} />
        ) : tab === "privacy" ? (
          <Privacy store={store} />
        ) : plan ? (
          <section className={styles.checkout} aria-label="Условия покупки">
            <button
              type="button"
              className={styles.back}
              onClick={() => {
                setSelected(null);
                setAccepted(false);
              }}
            >
              ← Все тарифы
            </button>
            <h3>{name(plan)}</h3>
            <p className={styles.price}>
              {price(plan)}{" "}
              <span>/ {plan.billing_period === "year" ? "год" : "месяц"}</span>
            </p>
            <p className={styles.allowance}>{allowance(plan)}</p>
            <p>{plan.description_ru || plan.description}</p>
            <PurchaseTerms period={plan.billing_period} />
            <p>{store.ai_usage_policy}</p>
            <RefundTerms store={store} />
            <label className={styles.consent}>
              <input
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />
              <span>
                Я ознакомился с{" "}
                <button type="button" onClick={() => navigate("offer")}>
                  условиями покупки и возврата
                </button>{" "}
                и{" "}
                <button type="button" onClick={() => navigate("privacy")}>
                  политикой данных
                </button>
                .
              </span>
            </label>
            <button type="button" className={styles.pay} disabled>
              Оплата пока недоступна
            </button>
          </section>
        ) : (
          <>
            <p className={styles.intro}>
              {exhausted
                ? "Вы использовали доступные запросы ИИ."
                : "Выберите количество запросов для вашей музыки."}{" "}
              Один месяц, продление вручную.
            </p>
            {audio && <p>Выберите тариф с аудиовложениями.</p>}
            {plans.length === 0 ? (
              <p role="status">Тарифы пока недоступны.</p>
            ) : (
              <div className={styles.plans}>
                {plans.map((item) => (
                  <section
                    className={styles.plan}
                    key={item.id}
                    aria-label={`Тариф ${name(item)}`}
                  >
                    <h3>{name(item)}</h3>
                    <div className={styles.price}>
                      {price(item)}
                      {item.billing_period !== "none" && (
                        <span>
                          / {item.billing_period === "month" ? "месяц" : "год"}
                        </span>
                      )}
                    </div>
                    <p className={styles.allowance}>{allowance(item)}</p>
                    <p>{item.description_ru || item.description}</p>
                    <ul>
                      {[...new Set(item.features_ru ?? item.features)].map(
                        (feature) => (
                          <li key={feature}>{feature}</li>
                        ),
                      )}
                    </ul>
                    {item.id === currentPlanId && (
                      <p className={styles.current}>Текущий тариф</p>
                    )}
                    <button
                      type="button"
                      disabled={item.is_default}
                      onClick={() => {
                        setSelected(item.id);
                        setAccepted(false);
                      }}
                    >
                      {item.is_default ? "Включено" : "Посмотреть условия"}
                    </button>
                  </section>
                ))}
              </div>
            )}
            <p className={styles.note}>{store.ai_usage_policy}</p>
          </>
        )}
        {store && (
          <footer className={styles.footer}>
            <p>Продажи ещё не открыты. Оплата пока недоступна.</p>
            <Seller store={store} />
          </footer>
        )}
      </div>
    </Dialog>
  );
}
