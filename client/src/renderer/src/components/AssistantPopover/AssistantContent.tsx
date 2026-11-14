import classNames from "classnames";
import { ArrowUp, Square, X } from "lucide-react";
import type { Ref } from "react";
import { AnimatedBorder } from "../AnimatedBorder/AnimatedBorder";
import { MarkdownAnswer } from "../MarkdownAnswer/MarkdownAnswer";
import styles from "./AssistantPopover.module.css";

// The editor and the tour share the same chat UI; requests stay with the caller.
export function AssistantContent({
  prompt,
  answer,
  error,
  pending,
  disabled = false,
  showComposer = true,
  inputRef,
  placeholder = "What would you like to make?",
  onPromptChange,
  onSubmit,
  onCancel,
  onClose,
}: {
  prompt: string;
  answer: string | null;
  error?: string | null;
  pending: boolean;
  disabled?: boolean;
  showComposer?: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  placeholder?: string;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onClose?: () => void;
}) {
  return (
    <>
      <AnimatedBorder active={pending} className={styles.rim} />
      {(answer || error) && (
        <div
          className={classNames(styles.answer, {
            [styles.error]: !!error,
            [styles.answerOnly]: !showComposer,
          })}
          role={error ? "alert" : "status"}
          aria-live="polite"
        >
          {error || (answer && <MarkdownAnswer>{answer}</MarkdownAnswer>)}
        </div>
      )}
      <span className={styles.srOnly} role="status">
        {pending ? "Working on it…" : ""}
      </span>
      {showComposer && (
        <form
          className={styles.composer}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <textarea
            ref={inputRef}
            aria-label="Ask Assist"
            placeholder={placeholder}
            value={prompt}
            readOnly={pending}
            maxLength={16000}
            rows={1}
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                onSubmit();
              }
            }}
          />
          <div className={styles.actions}>
            {pending ? (
              <button
                type="button"
                className={styles.send}
                aria-label="Cancel request"
                onClick={onCancel}
              >
                <Square size={12} fill="currentColor" />
              </button>
            ) : prompt.trim() ? (
              <button
                type="submit"
                className={styles.send}
                aria-label="Send request"
                disabled={disabled}
              >
                <ArrowUp size={17} />
              </button>
            ) : onClose ? (
              <button
                type="button"
                className={styles.closeButton}
                aria-label="Close assistant"
                title="Close (Esc)"
                onClick={onClose}
              >
                <X size={14} />
              </button>
            ) : null}
          </div>
        </form>
      )}
    </>
  );
}
