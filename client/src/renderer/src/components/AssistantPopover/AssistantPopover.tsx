import { isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import classNames from "classnames";
import { ArrowUp, Square, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { parseModule } from "../../../../shared/modules";
import { MarkdownAnswer } from "../MarkdownAnswer/MarkdownAnswer";
import styles from "./AssistantPopover.module.css";

export type AssistantPlacement = "cursor" | "bottom";

export function AssistantPopover({
  view,
  path,
  invocation,
  placement,
  disabled,
}: {
  view: EditorView;
  path: string;
  invocation: number;
  placement: AssistantPlacement;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [activePlacement, setActivePlacement] =
    useState<AssistantPlacement>("cursor");
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [closingHeight, setClosingHeight] = useState<number>();
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width?: number;
  }>({ left: 0, top: 0 });
  const input = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const request = useRef<string | null>(null);
  const lastInvocation = useRef(0);

  const cancel = useCallback(() => {
    if (request.current) window.workspace.cancelAssist(request.current);
    request.current = null;
    setPending(false);
  }, []);

  const close = useCallback(
    (focus = true) => {
      setClosingHeight(panel.current?.offsetHeight);
      cancel();
      setOpen(false);
      setAnswer(null);
      setError(null);
      if (focus && view.dom.isConnected) view.focus();
    },
    [cancel, view],
  );

  useEffect(
    () => () => {
      if (request.current) window.workspace.cancelAssist(request.current);
      request.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!invocation || invocation === lastInvocation.current) return;
    lastInvocation.current = invocation;
    if (open && placement === "cursor") {
      close();
      return;
    }
    setActivePlacement(placement);
    setVisible(true);
    setOpen(true);
  }, [invocation, open, placement, close]);

  useEffect(() => {
    if (disabled) close(false);
  }, [disabled, close]);

  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setVisible(false), 220);
    return () => clearTimeout(timer);
  }, [open]);

  useLayoutEffect(() => {
    if (open && invocation) input.current?.focus();
  }, [open, invocation]);

  const place = useCallback(() => {
    if (!panel.current || !view.dom.isConnected) return;
    if (activePlacement === "bottom") {
      const bounds = (
        view.dom.parentElement ?? view.dom
      ).getBoundingClientRect();
      const margin = 24;
      const width = Math.min(440, Math.max(0, bounds.width - margin * 2));
      setPosition({
        width,
        left: bounds.left + (bounds.width - width) / 2,
        top: Math.max(
          bounds.top + margin,
          bounds.bottom - margin - panel.current.offsetHeight,
        ),
      });
      return;
    }
    const cursor = view.coordsAtPos(view.state.selection.main.head);
    const bounds = view.dom.getBoundingClientRect();
    const width = panel.current.offsetWidth;
    const height = panel.current.offsetHeight;
    setPosition({
      left: Math.max(
        12,
        Math.min(
          cursor?.left ?? bounds.left + 30,
          window.innerWidth - width - 12,
        ),
      ),
      top: Math.max(
        60,
        Math.min(
          (cursor?.bottom ?? bounds.top) + 12,
          window.innerHeight - height - 12,
        ),
      ),
    });
  }, [view, activePlacement]);

  useLayoutEffect(() => {
    if (!visible || !invocation) return;
    place();
    window.addEventListener("resize", place);
    view.scrollDOM.addEventListener("scroll", place);
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    observer.observe(view.dom);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      view.scrollDOM.removeEventListener("scroll", place);
    };
  }, [view, visible, invocation, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target)
      )
        close(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", outside);
    };
  }, [open, close]);

  async function submit() {
    if (!prompt.trim() || request.current || disabled) return;
    const id = crypto.randomUUID();
    const snapshot = view.state.doc;
    const { anchor, head } = view.state.selection.main;
    request.current = id;
    setAnswer(null);
    setError(null);
    setPending(true);
    try {
      const result = await window.workspace.assist(id, {
        prompt: prompt.trim(),
        file: { path, content: snapshot.toString(), cursor: { anchor, head } },
      });
      if (request.current !== id || !view.dom.isConnected) return;
      if (result.code !== null && result.code !== snapshot.toString()) {
        if (view.state.doc !== snapshot || view.state.readOnly)
          throw new Error(
            "The file changed while I was working. Send the request again to use the latest code.",
          );
        try {
          parseModule(result.code, path);
        } catch {
          throw new Error(
            "The model returned invalid code. Your file is unchanged. Try again.",
          );
        }
        view.dispatch({
          changes: { from: 0, to: snapshot.length, insert: result.code },
          selection: {
            anchor: Math.min(anchor, result.code.length),
            head: Math.min(head, result.code.length),
          },
          annotations: isolateHistory.of("full"),
        });
      }
      setAnswer(result.message);
      setPrompt("");
    } catch (error) {
      if (request.current === id)
        setError(
          String(error instanceof Error ? error.message : error).replace(
            /^Error invoking remote method '[^']+': Error: /,
            "",
          ),
        );
    } finally {
      if (request.current === id) {
        request.current = null;
        setPending(false);
        input.current?.focus();
        requestAnimationFrame(place);
      }
    }
  }

  if (!visible) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="Wien assistant"
      aria-hidden={!open}
      inert={!open}
      data-assistant
      className={classNames(styles.panel, {
        [styles.closing]: !open,
        [styles.thinking]: pending,
      })}
      style={{ ...position, height: open ? undefined : closingHeight }}
      aria-busy={pending}
    >
      <span className={styles.rim} aria-hidden="true" />
      {(answer || error) && (
        <div
          className={classNames(styles.answer, { [styles.error]: !!error })}
          role={error ? "alert" : "status"}
          aria-live="polite"
        >
          {error || (answer && <MarkdownAnswer>{answer}</MarkdownAnswer>)}
        </div>
      )}
      <span className={styles.srOnly} role="status">
        {pending ? "Working on it…" : ""}
      </span>
      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={input}
          aria-label="Ask Wien"
          placeholder="What would you like to make?"
          value={prompt}
          readOnly={pending}
          maxLength={16000}
          rows={1}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className={styles.actions}>
          {pending ? (
            <button
              type="button"
              className={styles.send}
              aria-label="Cancel request"
              onClick={cancel}
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
          ) : (
            <button
              type="button"
              className={styles.closeButton}
              aria-label="Close assistant"
              title="Close (Esc)"
              onClick={() => close()}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </form>
    </div>,
    document.body,
  );
}
