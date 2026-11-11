import classNames from "classnames";
import { FileCode2, Package, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef } from "react";
import styles from "./FileTabs.module.css";

export interface FileTab {
  path: string;
  exported: boolean;
  dirty: boolean;
  playing: boolean;
}

export function FileTabs({
  tabs,
  active,
  disabled,
  onSelect,
  onClose,
  controller,
}: {
  tabs: FileTab[];
  active: string | null;
  disabled: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  controller?: {
    open: boolean;
    disabled: boolean;
    onSelect: () => void;
    onClose: () => void;
  };
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = controller?.open
      ? list.current?.querySelector('[data-controller-tab="true"]')
      : active
        ? list.current?.querySelector('[aria-selected="true"]')
        : null;
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, controller?.open]);

  return (
    <div
      className={styles.fileTabs}
      role="tablist"
      aria-label="Open snippets"
      ref={list}
    >
      {tabs.map((tab, index) => {
        const selected = !controller?.open && tab.path === active;
        const filename = tab.path.split("/").at(-1);
        const duplicateName = tabs.some(
          (other) =>
            other.path !== tab.path &&
            other.path.split("/").at(-1) === filename,
        );
        const Icon = tab.exported ? Package : FileCode2;
        return (
          <div
            className={classNames(styles.fileTab, {
              [styles.active]: selected,
              [styles.playing]: tab.playing,
            })}
            key={tab.path}
            role="presentation"
            data-playing={tab.playing || undefined}
          >
            <span className={styles.playingRim} aria-hidden="true" />
            <button
              type="button"
              role="tab"
              id={`tab-${encodeURIComponent(tab.path)}`}
              aria-label={tab.path}
              aria-selected={selected}
              aria-description={tab.playing ? "Playing" : undefined}
              aria-controls="snippet-panel"
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              title={`${tab.path}${tab.playing ? " · Playing" : ""}`}
              className={styles.fileTabSelect}
              onClick={() => onSelect(tab.path)}
              onKeyDown={(event) => {
                let next: number;
                if (event.key === "ArrowRight")
                  next = (index + 1) % tabs.length;
                else if (event.key === "ArrowLeft")
                  next = (index + tabs.length - 1) % tabs.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = tabs.length - 1;
                else return;
                event.preventDefault();
                list.current
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus();
                onSelect(tabs[next].path);
              }}
            >
              <Icon size={13} />
              <span className={styles.fileTabName}>{filename}</span>
              {duplicateName && (
                <span className={styles.fileTabFolder}>
                  {tab.path.includes("/")
                    ? tab.path.slice(0, tab.path.lastIndexOf("/"))
                    : "/"}
                </span>
              )}
              {tab.dirty && (
                <span
                  className={styles.unsavedDot}
                  role="img"
                  aria-label="Unsaved changes"
                />
              )}
            </button>
            <button
              type="button"
              className={styles.fileTabClose}
              aria-label={`Close ${tab.path}`}
              title="Close tab"
              disabled={disabled}
              onClick={() => onClose(tab.path)}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      {controller?.open && (
        <div
          className={classNames(styles.fileTab, styles.active)}
          role="presentation"
          data-controller-tab="true"
        >
          <button
            type="button"
            role="tab"
            aria-selected="true"
            aria-label="Controls view"
            tabIndex={0}
            className={styles.fileTabSelect}
            onClick={controller.onSelect}
          >
            <SlidersHorizontal size={13} />
            <span className={styles.fileTabName}>Controls</span>
          </button>
          <button
            type="button"
            className={styles.fileTabClose}
            aria-label="Close controls view"
            title="Close controls view"
            disabled={controller.disabled}
            onClick={controller.onClose}
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
