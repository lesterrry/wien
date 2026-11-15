import classNames from "classnames";
import { ArrowUp, Paperclip, Square, X, Zap } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { t, useLocale } from "../../i18n";
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
  turbo = false,
  onTurboChange,
  attachment,
  hasAudio = false,
  onAttach,
  inputRef,
  placeholder = t("What would you like to make?"),
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
  turbo?: boolean;
  onTurboChange?: (enabled: boolean) => void;
  attachment?: ReactNode;
  hasAudio?: boolean;
  onAttach?: () => void;
  inputRef?: Ref<HTMLTextAreaElement>;
  placeholder?: string;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onClose?: () => void;
}) {
  useLocale();
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
        {pending ? t("Working on it…") : ""}
      </span>
      {showComposer && (
        <>
          {attachment}
          <form
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <textarea
              ref={inputRef}
              aria-label={t("Ask Assist")}
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
              {onAttach && (
                <button
                  type="button"
                  className={styles.turbo}
                  aria-label={t("Add audio")}
                  title={t("Add MP3")}
                  disabled={pending || disabled}
                  onClick={onAttach}
                >
                  <Paperclip size={15} />
                </button>
              )}
              {onTurboChange && (
                <button
                  type="button"
                  className={styles.turbo}
                  aria-label={t("Turbo")}
                  aria-pressed={turbo}
                  title={
                    hasAudio
                      ? t("Turbo is unavailable with audio")
                      : t("Быстрее ответы, меньше точность")
                  }
                  disabled={pending || disabled || hasAudio}
                  onClick={() => onTurboChange(!turbo)}
                >
                  <Zap size={13} fill={turbo ? "currentColor" : "none"} />
                </button>
              )}
              {pending ? (
                <button
                  type="button"
                  className={styles.send}
                  aria-label={t("Cancel request")}
                  onClick={onCancel}
                >
                  <Square size={12} fill="currentColor" />
                </button>
              ) : prompt.trim() || hasAudio ? (
                <button
                  type="submit"
                  className={styles.send}
                  aria-label={t("Send request")}
                  disabled={disabled}
                >
                  <ArrowUp size={17} />
                </button>
              ) : onClose ? (
                <button
                  type="button"
                  className={styles.closeButton}
                  aria-label={t("Close assistant")}
                  title={t("Close (Esc)")}
                  onClick={onClose}
                >
                  <X size={14} />
                </button>
              ) : null}
            </div>
          </form>
        </>
      )}
    </>
  );
}
