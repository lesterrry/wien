import { useCallback, useEffect, useRef, useState } from "react";
import type { SubscriptionPlan } from "../../../../shared/account";
import type {
  PaymentConfig,
  PaymentOrder,
  PaymentRequest,
} from "../../../../shared/payments";
import { formatLocale, t, useLocale } from "../../i18n";
import common from "../../styles/common.module.css";
import { Consent } from "./Consent";
import styles from "./SubscriptionPlans.module.css";

const api = window.workspace;
const message = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );
const amount = (order: PaymentOrder) =>
  new Intl.NumberFormat(formatLocale(), {
    style: "currency",
    currency: order.currency,
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(order.price_minor / 100);
const states = {
  pending: "Ожидает оплаты",
  cancelled: "Заказ отменён",
  paid: "Оплата подтверждена · подписка активирована",
  paid_review: "Оплата получена · нужна проверка поддержки",
};
export function Payments({
  config,
  plans,
  userId,
  purchase,
  returnOrderId,
  supportEmail,
  onSignIn,
  onPaid,
  onNavigate,
  consent,
  onConsent,
}: {
  config: PaymentConfig;
  plans: SubscriptionPlan[];
  userId?: string;
  purchase?: PaymentRequest;
  returnOrderId?: string;
  supportEmail: string;
  onSignIn: () => void;
  onPaid: () => Promise<unknown>;
  onNavigate: (tab: "offer" | "privacy") => void;
  consent: Record<string, boolean>;
  onConsent: (id: string, checked: boolean) => void;
}) {
  const locale = useLocale();
  const descriptions = new Map(
    plans.map((plan) => [
      plan.id,
      locale === "ru"
        ? plan.description_ru || plan.description
        : plan.description,
    ]),
  );
  const [orders, setOrders] = useState<PaymentOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [focused, setFocused] = useState(returnOrderId);
  const busyRef = useRef(false);
  const started = useRef(false);
  const revision = useRef(0);
  const pending = useRef(false);
  const paid = useRef(new Set<string>());
  const acceptOrders = useCallback(
    async (items: PaymentOrder[]) => {
      setOrders(items);
      pending.current = items.some((item) => item.status === "pending");
      if (
        items.some(
          (item) => item.status === "paid" && !paid.current.has(item.id),
        )
      ) {
        await onPaid();
        for (const item of items)
          if (item.status === "paid") paid.current.add(item.id);
      }
    },
    [onPaid],
  );
  const load = useCallback(async () => {
    if (busyRef.current) return;
    const version = ++revision.current;
    try {
      const history = userId ? await api.paymentOrders() : [];
      let returnError = "";
      if (
        returnOrderId &&
        userId &&
        !history.some((item) => item.id === returnOrderId)
      ) {
        try {
          history.unshift(await api.paymentOrder(returnOrderId));
        } catch (e) {
          returnError = message(e);
        }
      }
      if (version !== revision.current) return;
      setError(returnError);
      await acceptOrders(history);
    } catch (e) {
      if (version === revision.current) setError(message(e));
    } finally {
      if (version === revision.current) setLoading(false);
    }
  }, [userId, returnOrderId, acceptOrders]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (pending.current && document.visibilityState === "visible")
        void load();
    }, 3000);
    const focus = () => {
      void load();
    };
    window.addEventListener("focus", focus);
    return () => {
      revision.current++;
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [load]);
  async function mutate(action: () => Promise<PaymentOrder>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    const version = ++revision.current;
    try {
      const order = await action();
      if (version !== revision.current) return;
      setFocused(order.id);
      await acceptOrders([
        order,
        ...orders.filter((item) => item.id !== order.id),
      ]);
    } catch (e) {
      if (version === revision.current) setError(message(e));
    } finally {
      busyRef.current = false;
      if (version === revision.current) setBusy(false);
    }
  }
  async function begin() {
    if (!purchase) return;
    const existing = orders.find((item) => item.status === "pending");
    if (existing) {
      setFocused(existing.id);
      if (existing.plan_id !== purchase.plan_id)
        setError(
          "У вас уже есть неоплаченный заказ на другой тариф. Оплатите или отмените его, чтобы выбрать новый.",
        );
      return;
    }
    await mutate(() => api.paymentCreate(purchase));
  }
  // A plan-card click creates an unpaid order once. Retries keep its request ID.
  // biome-ignore lint/correctness/useExhaustiveDependencies: begin uses the current history after the initial load.
  useEffect(() => {
    if (
      !loading &&
      userId &&
      purchase &&
      config.mode !== "disabled" &&
      !started.current
    ) {
      started.current = true;
      void begin();
    }
  }, [loading, userId, purchase, config.mode]);
  const shown = purchase
    ? orders.filter((order) => order.id === focused)
    : orders;
  async function pay(order: PaymentOrder) {
    if (!consent[order.id]) return;
    await mutate(async () => {
      const checkout = order;
      if (!checkout.checkout_url)
        throw new Error(
          "Заказ больше недоступен для оплаты. Проверьте его статус.",
        );
      if (api.platform === "web") {
        const back = new URL(window.location.href);
        back.searchParams.set("payment", order.id);
        window.history.replaceState(null, "", back);
        window.location.assign(checkout.checkout_url);
      } else {
        await api.openExternalLink(checkout.checkout_url);
      }
      return checkout;
    });
  }
  return (
    <section className={styles.payments} aria-label={t("Платежи")}>
      {(loading || (busy && shown.length === 0)) && (
        <p role="status">{t("Готовим заказ…")}</p>
      )}
      {config.mode === "disabled" && <p>{t("Оплата пока недоступна.")}</p>}
      {!userId && (
        <button
          type="button"
          className={common.primaryButton}
          onClick={onSignIn}
        >
          {t("Войти для оплаты")}
        </button>
      )}
      {error && <p role="alert">{t(error)}</p>}
      {purchase && userId && error && shown.length === 0 && (
        <button
          type="button"
          className={common.primaryButton}
          disabled={busy}
          onClick={() => {
            void begin();
          }}
        >
          {t("Попробовать снова")}
        </button>
      )}
      {!purchase && !loading && userId && orders.length === 0 && !error && (
        <p>{t("У вас пока нет платежей.")}</p>
      )}
      {shown.map((order) => (
        <article
          key={order.id}
          className={styles.order}
          aria-label={t("Заказ {id}", { id: order.invoice_id })}
        >
          <p className={styles.orderNumber}>
            {t("Заказ №")} {order.invoice_id}
          </p>
          <h3>
            {order.plan_name} · {t("один месяц")}
          </h3>
          {descriptions.get(order.plan_id) && (
            <p>{descriptions.get(order.plan_id)}</p>
          )}
          <div className={styles.total}>
            <span>{t(order.status === "pending" ? "К оплате" : "Итого")}</span>
            <strong>{amount(order)}</strong>
          </div>
          {order.status === "pending" ? (
            <>
              <Consent
                checked={!!consent[order.id]}
                onChange={(checked) => onConsent(order.id, checked)}
                onNavigate={onNavigate}
              />
              <button
                type="button"
                className={styles.pay}
                disabled={
                  busy || !consent[order.id] || config.mode === "disabled"
                }
                onClick={() => {
                  void pay(order);
                }}
              >
                {busy
                  ? t("Подождите…")
                  : t("Оплатить {amount}", { amount: amount(order) })}
              </button>
              <p className={styles.paymentMethod}>
                {t("Безопасная оплата через Robokassa")}
              </p>
              <div className={styles.orderActions}>
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={busy}
                  onClick={() => {
                    void mutate(() => api.paymentCancel(order.id));
                  }}
                >
                  {t("Отменить заказ")}
                </button>
              </div>
            </>
          ) : (
            <p className={styles.orderStatus} role="status">
              {t(states[order.status])}
            </p>
          )}
          {order.period_ends_at && (
            <p>
              {t("Подписка действует до")}{" "}
              {new Date(order.period_ends_at).toLocaleString(formatLocale())}.
            </p>
          )}
          {order.status === "cancelled" && (
            <p>{t("Для новой покупки выберите тариф.")}</p>
          )}
          {order.status === "paid_review" && (
            <p>
              {t("Напишите")}{" "}
              <a
                href={`mailto:${supportEmail}?subject=${encodeURIComponent(`Wien: заказ ${order.invoice_id}`)}`}
              >
                {supportEmail}
              </a>
              , {t("указав номер заказа.")}
            </p>
          )}
        </article>
      ))}
    </section>
  );
}
