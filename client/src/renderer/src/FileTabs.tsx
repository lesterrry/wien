import { FileCode2, Package, X } from "lucide-react";
import { useEffect, useRef } from "react";

export interface FileTab {
  path: string;
  exported: boolean;
  dirty: boolean;
}

export function FileTabs({
  tabs,
  active,
  disabled,
  onSelect,
  onClose,
}: {
  tabs: FileTab[];
  active: string | null;
  disabled: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active)
      list.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <div
      className="file-tabs"
      role="tablist"
      aria-label="Open snippets"
      ref={list}
    >
      {tabs.map((tab, index) => {
        const selected = tab.path === active;
        const filename = tab.path.split("/").at(-1);
        const duplicateName = tabs.some(
          (other) =>
            other.path !== tab.path &&
            other.path.split("/").at(-1) === filename,
        );
        const Icon = tab.exported ? Package : FileCode2;
        return (
          <div
            className={`file-tab ${selected ? "active" : ""}`}
            key={tab.path}
            role="presentation"
          >
            <button
              type="button"
              role="tab"
              id={`tab-${encodeURIComponent(tab.path)}`}
              aria-label={tab.path}
              aria-selected={selected}
              aria-controls="snippet-panel"
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              title={tab.path}
              className="file-tab-select"
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
              <span className="file-tab-name">{filename}</span>
              {duplicateName && (
                <span className="file-tab-folder">
                  {tab.path.includes("/")
                    ? tab.path.slice(0, tab.path.lastIndexOf("/"))
                    : "/"}
                </span>
              )}
              {tab.dirty && (
                <span
                  className="unsaved-dot"
                  role="img"
                  aria-label="Unsaved changes"
                />
              )}
            </button>
            <button
              type="button"
              className="file-tab-close"
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
    </div>
  );
}
