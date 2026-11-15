import { useCallback, useEffect, useRef, useState } from "react";
import type { SubscriptionPlan } from "../../../../shared/account";
import type { PaymentConfig, PaymentOrder } from "../../../../shared/payments";
import styles from "./SubscriptionPlans.module.css";

const api = window.workspace;
const message = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );
const states = {
  pending: "Ожидаем подтверждения оплаты",
  cancelled: "Заказ отменён",
  paid: "Оплата подтверждена · подписка активирована",
  paid_review: "Оплата получена · нужна проверка поддержки",
};
export function Payments({
  config,
  userId,
  plan,
  documentVersion,
  accepted = false,
  returnOrderId,
  supportEmail,
  onSignIn,
  onPaid,
}: {
  config: PaymentConfig;
  userId?: string;
  plan?: SubscriptionPlan;
  documentVersion: string;
  accepted?: boolean;
  returnOrderId?: string;
  supportEmail: string;
  onSignIn: () => void;
  onPaid: () => Promise<unknown>;
}) {
  const [orders, setOrders] = useState<PaymentOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [focused, setFocused] = useState(returnOrderId);
  const requestId = useRef(crypto.randomUUID());
  const busyRef = useRef(false);
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
      if (order.status !== "pending") requestId.current = crypto.randomUUID();
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
  const shown = plan
    ? orders.filter(
        (order) => order.id === focused || order.status === "pending",
      )
    : orders;
  const hasPending = orders.some((order) => order.status === "pending");
  return (
    <section className={styles.payments} aria-label="Платежи">
      {loading && <p role="status">Проверяем оплату…</p>}
      {config?.mode === "test" && (
        <p className={styles.testNotice}>
          Тестовый режим Robokassa. Деньги не списываются. Доступно только
          тестовым аккаунтам.
        </p>
      )}
      {config?.mode === "disabled" && <p>Оплата пока недоступна.</p>}
      {!userId && (config?.mode === "test" || !plan) && (
        <button type="button" className={styles.pay} onClick={onSignIn}>
          {config?.mode === "test"
            ? "Войти для оплаты"
            : "Войти для просмотра платежей"}
        </button>
      )}
      {plan && (userId || config?.mode !== "test") && (
        <button
          type="button"
          className={styles.pay}
          disabled={
            loading ||
            busy ||
            config?.mode !== "test" ||
            !accepted ||
            hasPending
          }
          onClick={() => {
            void mutate(() =>
              api.paymentCreate({
                request_id: requestId.current,
                plan_id: plan.id,
                price_minor: plan.price_minor,
                request_limit: plan.initial_assist_requests ?? 0,
                document_version: documentVersion,
                accepted,
              }),
            );
          }}
        >
          {busy
            ? "Создаём заказ…"
            : config?.mode === "test"
              ? "Создать тестовый заказ"
              : "Оплата пока недоступна"}
        </button>
      )}
      {plan && config?.mode === "test" && (
        <p>
          Новый месяц можно купить после окончания действующей подписки.
          Автоматических списаний нет.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {(error || (userId && !loading)) && (
        <button
          type="button"
          className={styles.back}
          disabled={busy}
          onClick={() => {
            void load();
          }}
        >
          Проверить статус
        </button>
      )}
      {!plan && !loading && userId && orders.length === 0 && !error && (
        <p>У вас пока нет платежей.</p>
      )}
      {shown.map((order) => (
        <article
          key={order.id}
          className={styles.order}
          aria-label={`Заказ ${order.invoice_id}`}
        >
          <h3>
            {order.plan_name} ·{" "}
            {new Intl.NumberFormat("ru-RU", {
              style: "currency",
              currency: order.currency,
            }).format(order.price_minor / 100)}
          </h3>
          <p>
            {order.request_limit.toLocaleString("ru-RU")} запросов · один месяц
            · тестовый платёж
          </p>
          <p className={styles.orderStatus} role="status">
            {states[order.status]}
          </p>
          <p>
            Заказ № {order.invoice_id} ·{" "}
            {new Date(order.created_at).toLocaleString("ru-RU")}
          </p>
          {order.period_ends_at && (
            <p>
              Подписка действует до{" "}
              {new Date(order.period_ends_at).toLocaleString("ru-RU")}.
            </p>
          )}
          {order.status === "pending" && (
            <>
              <p>
                Откройте Robokassa и завершите тестовую оплату. Этот экран
                обновится после подтверждения сервера.
              </p>
              <div className={styles.orderActions}>
                {order.checkout_url && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void api
                        .openExternalLink(order.checkout_url as string)
                        .catch((e: unknown) => setError(message(e)));
                    }}
                  >
                    Открыть Robokassa
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void mutate(() => api.paymentCancel(order.id));
                  }}
                >
                  Отменить заказ
                </button>
              </div>
            </>
          )}
          {order.status === "cancelled" && (
            <p>
              Не оплачивайте старую ссылку. Для повторной попытки создайте новый
              заказ.
            </p>
          )}
          {order.status === "paid_review" && (
            <p>
              Подписка по этому заказу не включена автоматически. Напишите{" "}
              <a
                href={`mailto:${supportEmail}?subject=${encodeURIComponent(`Wien: заказ ${order.invoice_id}`)}`}
              >
                {supportEmail}
              </a>
              , указав номер заказа.
            </p>
          )}
        </article>
      ))}
    </section>
  );
}
