import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import styles from "./Dialog.module.css";

export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      onCancel={onClose}
      aria-label={title}
    >
      <div className={styles.dialogHeading}>
        <h2>{title}</h2>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
