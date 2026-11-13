import classNames from "classnames";
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
      title={`Go to ${name} declaration`}
      disabled={disabled}
      onClick={() => onDefinition(name)}
    >
      {name}
    </button>
  );
}
