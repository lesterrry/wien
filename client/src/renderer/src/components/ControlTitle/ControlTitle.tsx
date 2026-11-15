import classNames from "classnames";
import { t, useLocale } from "../../i18n";
import styles from "./ControlTitle.module.css";

export function ControlTitle({
  name,
  className,
  disabled,
  onDefinition,
}: {
  name: string;
  className: string;
  disabled: boolean;
  onDefinition?: (name: string) => void;
}) {
  useLocale();
  if (!onDefinition)
    return (
      <span className={className} title={name}>
        {name}
      </span>
    );
  return (
    <button
      type="button"
      className={classNames(className, styles.title)}
      title={t("Go to {p0} declaration", { p0: name })}
      disabled={disabled}
      onClick={() => onDefinition(name)}
    >
      {name}
    </button>
  );
}
