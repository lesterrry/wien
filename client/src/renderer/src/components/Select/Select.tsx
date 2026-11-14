import classNames from "classnames";
import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import styles from "./Select.module.css";

export function Select({
  className,
  children,
  ...props
}: ComponentProps<"select">) {
  return (
    <span className={styles.field}>
      <select {...props} className={classNames(styles.select, className)}>
        {children}
      </select>
      <ChevronDown className={styles.chevron} size={14} aria-hidden="true" />
    </span>
  );
}
