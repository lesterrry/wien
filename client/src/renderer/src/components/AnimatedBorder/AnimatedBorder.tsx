import classNames from "classnames";
import styles from "./AnimatedBorder.module.css";

/** Decorative border; the parent provides positioning and corner radius. */
export function AnimatedBorder({
  active,
  className,
}: {
  active: boolean;
  className?: string;
}) {
  return (
    <span
      className={classNames(styles.border, className, {
        [styles.active]: active,
      })}
      aria-hidden="true"
    />
  );
}
