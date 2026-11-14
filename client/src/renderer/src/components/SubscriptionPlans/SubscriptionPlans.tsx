import { Dialog } from "../Dialog/Dialog";
import styles from "./SubscriptionPlans.module.css";

const plans = [
  { name: "PLUS", price: "199" },
  { name: "PRO", price: "699" },
  { name: "ULTRA", price: "3 990" },
];

export function SubscriptionPlans({
  exhausted,
  audio = false,
  onClose,
}: {
  exhausted: boolean;
  audio?: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      title="Explore subscriptions"
      onClose={onClose}
      className={styles.dialog}
    >
      <p className={styles.intro}>
        {exhausted && !audio
          ? "You've used all your assist requests."
          : "Find your next plan."}{" "}
        Upgrade for more usage.
      </p>
      {audio && (
        <section className={styles.audio} aria-label="Audio attachments">
          <h3>Audio attachments</h3>
          <p>
            Available on Plus, Pro and Ultra. Upload an MP3, select up to 10
            seconds and let Assist recreate it as an editable snippet.
          </p>
          <p>
            Audio requests are counted separately from text requests. Turbo is
            unavailable with audio attachments.
          </p>
        </section>
      )}
      <div className={styles.plans}>
        {plans.map((plan) => (
          <section
            className={styles.plan}
            key={plan.name}
            aria-label={`${plan.name} subscription`}
          >
            <h3>{plan.name}</h3>
            <div className={styles.price}>
              {plan.price} <span>₽ / month</span>
            </div>
            <button type="button" disabled>
              Coming soon
            </button>
          </section>
        ))}
      </div>
      {/* <p className={styles.note}>
        Billed monthly.
      </p> */}
    </Dialog>
  );
}
