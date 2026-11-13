import classNames from "classnames";
import {
  FileCode2,
  Network,
  Package,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { AnimatedBorder } from "../AnimatedBorder/AnimatedBorder";
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
  graph,
}: {
  tabs: FileTab[];
  active: string | null;
  disabled: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  graph: {
    open: boolean;
    active: boolean;
    onSelect: () => void;
    onClose: () => void;
  };
  controller?: {
    open: boolean;
    disabled: boolean;
    onSelect: () => void;
    onClose: () => void;
  };
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active && !controller?.open && !graph.active) return;
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, controller?.open, graph.active]);

  return (
    <div
      className={styles.fileTabs}
      role="tablist"
      aria-label="Open snippets"
      ref={list}
      onKeyDown={(event) => {
        if (
          !(event.target instanceof HTMLButtonElement) ||
          event.target.getAttribute("role") !== "tab"
        )
          return;
        const buttons = [
          ...(list.current?.querySelectorAll<HTMLButtonElement>(
            '[role="tab"]:not(:disabled)',
          ) ?? []),
        ];
        const index = buttons.indexOf(event.target);
        let next: number;
        if (event.key === "ArrowRight") next = (index + 1) % buttons.length;
        else if (event.key === "ArrowLeft")
          next = (index + buttons.length - 1) % buttons.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = buttons.length - 1;
        else return;
        event.preventDefault();
        buttons[next]?.focus();
        buttons[next]?.click();
      }}
    >
      {tabs.map((tab) => {
        const selected =
          !controller?.open && !graph.active && tab.path === active;
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
            })}
            key={tab.path}
            role="presentation"
            data-playing={tab.playing || undefined}
          >
            <AnimatedBorder active={tab.playing} />
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
              <span
                className={styles.unsavedDot}
                role="img"
                aria-label="Unsaved changes"
                aria-hidden={!tab.dirty}
              />
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
      {graph.open && (
        <div
          className={classNames(styles.fileTab, {
            [styles.active]: graph.active,
          })}
          role="presentation"
        >
          <button
            type="button"
            role="tab"
            id="tab-graph"
            aria-label="Graph View"
            aria-selected={graph.active}
            aria-controls="snippet-panel"
            tabIndex={graph.active ? 0 : -1}
            disabled={disabled}
            className={styles.fileTabSelect}
            onClick={graph.onSelect}
          >
            <Network size={13} />
            <span className={styles.fileTabName}>Graph View</span>
          </button>
          <button
            type="button"
            className={styles.fileTabClose}
            aria-label="Close Graph View"
            title="Close Graph View"
            disabled={disabled}
            onClick={graph.onClose}
          >
            <X size={12} />
          </button>
        </div>
      )}
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
