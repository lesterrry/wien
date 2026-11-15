import { ArrowDownToLine, Loader2, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { type Entry, isWithin } from "../../../../shared/types";
import { t, useLocale } from "../../i18n";
import type { FileOperation } from "../App/workspace-types";
import { Dialog } from "../Dialog/Dialog";

import styles from "./FileOperationDialog.module.css";

const folders = (entries: Entry[]): Entry[] =>
  entries.flatMap((entry) =>
    entry.children ? [entry, ...folders(entry.children)] : [],
  );

export function FileOperationDialog({
  modal,
  entries,
  projectName,
  value,
  onValue,
  busy,
  modalError,
  onSubmit,
  onClose,
}: {
  modal: FileOperation;
  entries: Entry[];
  projectName?: string;
  value: string;
  onValue: (value: string) => void;
  busy: boolean;
  modalError: string | null;
  onSubmit: () => void;
  onClose: () => void;
}) {
  useLocale();
  const modalNameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = modalNameInput.current;
    if (!input || !modal) return;
    input.focus();
    const isFile =
      (modal.kind === "create" && !modal.folder) ||
      (modal.kind === "rename" && !modal.entry.children);
    const extensionStart = input.value.lastIndexOf(".");
    const selectionEnd =
      isFile && extensionStart > 0 ? extensionStart : input.value.length;
    input.setSelectionRange(0, selectionEnd);
  }, [modal]);

  const title =
    modal.kind === "create"
      ? modal.folder
        ? t("New folder")
        : t("New snippet")
      : modal.kind === "reload"
        ? t("Reload saved file?")
        : modal.kind === "rename"
          ? t("Rename")
          : modal.kind === "move"
            ? t("Move to folder")
            : window.workspace.platform === "web"
              ? t("Delete?")
              : t("Move to Trash?");

  return (
    <Dialog
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className={styles.modalForm}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {modal.kind === "reload" ? (
          <p>
            {t(
              "Unsaved edits will be discarded. Copy anything you want to keep before reloading the saved file.",
            )}
          </p>
        ) : modal.kind === "delete" ? (
          <p>
            <strong>{modal.entry.name}</strong>
            {modal.entry.children ? t(" and everything inside it") : ""}
            {window.workspace.platform === "web"
              ? t(" will be permanently deleted from this browser project.")
              : t(" will move to your computer’s Trash.")}
          </p>
        ) : modal.kind === "move" ? (
          <>
            <label htmlFor="destination">{t("Destination")}</label>
            <select
              id="destination"
              value={value}
              onChange={(event) => onValue(event.target.value)}
            >
              <option value="">{t("Project root")}</option>
              {folders(entries)
                .filter((entry) => !isWithin(entry.id, modal.entry.id))
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.id}
                  </option>
                ))}
            </select>
          </>
        ) : (
          <>
            <label htmlFor="item-name">
              {modal.kind === "create" && modal.folder
                ? t("Folder name")
                : t("Name")}
            </label>
            <input
              id="item-name"
              value={value}
              ref={modalNameInput}
              onChange={(event) => onValue(event.target.value)}
              autoComplete="off"
            />
            <p className={styles.fieldHint}>
              {modal.kind === "create"
                ? t("In {p0}", {
                    p0: modal.parent || projectName || t("project root"),
                  })
                : t("Use .strudel or .js for snippets.")}
            </p>
          </>
        )}
        {modalError && (
          <p role="alert" className={styles.formError}>
            {t(modalError)}
          </p>
        )}
        <div className={styles.dialogActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy}
            onClick={onClose}
          >
            {t("Cancel")}
          </button>
          <button
            type="submit"
            className={
              modal.kind === "delete"
                ? styles.dangerButton
                : styles.primaryButton
            }
            disabled={busy}
          >
            {busy ? (
              <Loader2 size={14} className={styles.spin} />
            ) : modal.kind === "delete" ? (
              <Trash2 size={14} />
            ) : (
              <ArrowDownToLine size={14} />
            )}
            {modal.kind === "create"
              ? t("Create")
              : modal.kind === "delete"
                ? window.workspace.platform === "web"
                  ? t("Delete")
                  : t("Move to Trash")
                : modal.kind === "move"
                  ? t("Move")
                  : modal.kind === "reload"
                    ? t("Discard and reload")
                    : t("Rename")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
