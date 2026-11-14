import { useEffect, useState } from "react";
import type { SubscriptionPlan } from "../../../../shared/account";
import { Dialog } from "../Dialog/Dialog";
import styles from "./SubscriptionPlans.module.css";

export function SubscriptionPlans({
  exhausted,
  audio = false,
  currentPlanId,
  onClose,
}: {
  exhausted: boolean;
  audio?: boolean;
  currentPlanId?: string;
  onClose: () => void;
}) {
  const [plans, setPlans] = useState<SubscriptionPlan[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed catalog request.
  useEffect(() => {
    let active = true;
    setError(false);
    setPlans(null);
    void window.workspace.subscriptionPlans().then(
      (catalog) => {
        if (active) setPlans(catalog);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  return (
    <Dialog
      title="Explore subscriptions"
      onClose={onClose}
      className={styles.dialog}
    >
      <p className={styles.intro}>
        {exhausted && !audio
          ? "You've used all your assist requests."
          : "Find your next plan."}
      </p>
      {audio && <p>Choose a plan that includes audio attachments.</p>}
      {error ? (
        <div role="alert">
          <p>Unable to load subscription plans.</p>
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      ) : plans === null ? (
        <p role="status">Loading plans…</p>
      ) : plans.length === 0 ? (
        <p role="status">No plans are currently available.</p>
      ) : (
        <div className={styles.plans}>
          {plans.map((plan) => (
            <section
              className={styles.plan}
              key={plan.id}
              aria-label={`${plan.name} subscription`}
            >
              <h3>{plan.name}</h3>
              <div className={styles.price}>
                {new Intl.NumberFormat(undefined, {
                  style: "currency",
                  currency: plan.currency,
                  minimumFractionDigits: 0,
                  maximumFractionDigits: plan.currency_minor_units,
                }).format(plan.price_minor / 10 ** plan.currency_minor_units)}
                {plan.billing_period !== "none" && (
                  <span>/ {plan.billing_period}</span>
                )}
              </div>
              <p>{plan.description}</p>
              <ul>
                {[...new Set(plan.features)].map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <button type="button" disabled>
                {plan.id === currentPlanId
                  ? "Current plan"
                  : plan.is_default
                    ? "Included"
                    : "Coming soon"}
              </button>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  );
}
