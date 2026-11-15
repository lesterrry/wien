import { t } from "../../i18n";
import styles from "./SubscriptionPlans.module.css";

export function Consent({
  checked,
  onChange,
  onNavigate,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  onNavigate: (tab: "offer" | "privacy") => void;
}) {
  return (
    <label className={styles.consent}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {t("Я ознакомился с")}{" "}
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            onNavigate("offer");
          }}
        >
          {t("условиями покупки и возврата")}
        </button>{" "}
        {t("и")}{" "}
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            onNavigate("privacy");
          }}
        >
          {t("политикой данных")}
        </button>
        .
      </span>
    </label>
  );
}
