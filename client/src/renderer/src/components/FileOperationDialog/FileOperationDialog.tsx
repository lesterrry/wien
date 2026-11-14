import { ArrowDownToLine, Loader2, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { type Entry, isWithin } from "../../../../shared/types";
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
  const modalNameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = modalNameInput.current;
    if (!input || !modal) return;
    input.focus();
    const selectionEnd =
      modal.kind === "create" &&
      !modal.folder &&
      input.value.endsWith(".strudel")
        ? input.value.length - ".strudel".length
        : input.value.length;
    input.setSelectionRange(0, selectionEnd);
  }, [modal]);

  const title =
    modal.kind === "create"
      ? modal.folder
        ? "New folder"
        : "New snippet"
      : modal.kind === "reload"
        ? "Reload saved file?"
        : modal.kind === "rename"
          ? "Rename"
          : modal.kind === "move"
            ? "Move to folder"
            : window.workspace.platform === "web"
              ? "Delete?"
              : "Move to Trash?";

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
            Unsaved edits will be discarded. Copy anything you want to keep
            before reloading the saved file.
          </p>
        ) : modal.kind === "delete" ? (
          <p>
            <strong>{modal.entry.name}</strong>
            {modal.entry.children ? " and everything inside it" : ""}
            {window.workspace.platform === "web"
              ? " will be permanently deleted from this browser project."
              : " will move to your computer’s Trash."}
          </p>
        ) : modal.kind === "move" ? (
          <>
            <label htmlFor="destination">Destination</label>
            <select
              id="destination"
              value={value}
              onChange={(event) => onValue(event.target.value)}
            >
              <option value="">Project root</option>
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
              {modal.kind === "create" && modal.folder ? "Folder name" : "Name"}
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
                ? `In ${modal.parent || projectName || "project root"}`
                : "Use .strudel or .js for snippets."}
            </p>
          </>
        )}
        {modalError && (
          <p role="alert" className={styles.formError}>
            {modalError}
          </p>
        )}
        <div className={styles.dialogActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy}
            onClick={onClose}
          >
            Cancel
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
              ? "Create"
              : modal.kind === "delete"
                ? window.workspace.platform === "web"
                  ? "Delete"
                  : "Move to Trash"
                : modal.kind === "move"
                  ? "Move"
                  : modal.kind === "reload"
                    ? "Discard and reload"
                    : "Rename"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
