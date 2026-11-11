import classNames from "classnames";
import {
  ChevronDown,
  ChevronRight,
  Maximize2,
  Pin,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type ControlGroup,
  controlSources,
  type PanelLayout,
  sourceLabel,
} from "../../../../shared/control-tree";
import type { Control } from "../../../../shared/controls";
import { BooleanSwitch } from "../BooleanSwitch/BooleanSwitch";
import { NumberKnob } from "../NumberKnob/NumberKnob";
import styles from "./ControlsPanel.module.css";

type Menu = { x: number; y: number } & (
  | { kind: "control"; path: string; control: Control }
  | { kind: "group"; group: ControlGroup }
);

export function ControlsPanel({
  tree,
  root,
  pinned,
  loading,
  disabled,
  layout,
  errors,
  onPin,
  onLayout,
  onChange,
  onIgnore,
  onDefinition,
  onMove,
  onOpenController,
}: {
  tree: ControlGroup | null;
  root: string | null;
  pinned: boolean;
  loading: boolean;
  disabled: boolean;
  layout: PanelLayout;
  errors: Record<string, string>;
  onPin: () => void;
  onLayout: (layout: PanelLayout) => void;
  onChange: (path: string, name: string, value: number | boolean) => void;
  onIgnore: (path: string, name: string) => void;
  onDefinition: (path: string, name: string) => void;
  onMove: (
    path: string,
    name: string,
    targetName: string,
    placement: "before" | "after",
  ) => void;
  onOpenController: () => void;
}) {
  const [drag, setDrag] = useState<{
    file: string;
    name: string;
    over: string | null;
    side: "before" | "after";
  } | null>(null);
  const dragAllowed = useRef(true);
  const shortcut = navigator.platform.includes("Mac") ? "⌥" : "Alt";
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<Menu | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", key);
    };
  }, [menu]);
  const query = search.trim().toLocaleLowerCase();
  const names = tree ? controlSources(tree) : new Map<string, Set<string>>();
  const hidden: ControlGroup[] = [];
  function collectHidden(group: ControlGroup) {
    if (layout.hidden[group.id]) hidden.push(group);
    group.children.forEach(collectHidden);
  }
  if (tree) collectHidden(tree);
  const matches = (path: string, name: string) =>
    `${path} ${name}`.toLocaleLowerCase().includes(query);
  function contains(group: ControlGroup): boolean {
    if (layout.hidden[group.id]) return false;
    return (
      !query ||
      matches(group.path, "") ||
      group.controls.some((control) => matches(group.path, control.name)) ||
      Boolean(group.issues?.some((issue) => matches(group.path, issue.name))) ||
      group.children.some(contains)
    );
  }
  function renderGroup(group: ControlGroup) {
    if (!contains(group)) return null;
    const collapsed = !query && (layout.collapsed[group.id] ?? group.repeated);
    return (
      <section
        key={group.id}
        className={styles.group}
        aria-label={`${group.path} controls`}
      >
        <button
          type="button"
          className={styles.groupHeading}
          title={group.path}
          aria-label={`Toggle ${group.path} group`}
          aria-expanded={!collapsed}
          onClick={() =>
            onLayout({
              ...layout,
              collapsed: { ...layout.collapsed, [group.id]: !collapsed },
            })
          }
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({
              kind: "group",
              group,
              x: Math.min(event.clientX, window.innerWidth - 210),
              y: Math.min(event.clientY, window.innerHeight - 90),
            });
          }}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <span>{group.path.split("/").at(-1)}</span>
          {group.repeated && (
            <small title="Shared controls, repeated import">
              Repeated import
            </small>
          )}
        </button>
        {!collapsed && (
          <div className={styles.groupBody}>
            {group.error && (
              <p role="alert" className={styles.issue}>
                {group.error}
              </p>
            )}
            {group.issues
              ?.filter((issue) => matches(group.path, issue.name))
              .map((issue) => (
                <p key={issue.name} role="alert" className={styles.issue}>
                  <strong>{issue.name}</strong>: {issue.message}
                </p>
              ))}
            {group.controls
              .filter((control) => matches(group.path, control.name))
              .map((control) => {
                const index = group.controls.indexOf(control);
                const isOver =
                  drag?.file === group.path &&
                  drag?.over === control.name &&
                  drag.name !== control.name;
                const peers = names.get(control.name) ?? new Set<string>();
                const error =
                  errors[JSON.stringify([group.path, control.name])];
                return (
                  <fieldset
                    key={control.name}
                    className={classNames(styles.controlRow, styles.control, {
                      [styles.rowDragging]:
                        drag?.file === group.path &&
                        drag?.name === control.name,
                      [styles.dropBefore]: isOver && drag?.side === "before",
                      [styles.dropAfter]: isOver && drag?.side === "after",
                    })}
                    aria-label={`${control.name} control`}
                    draggable={!disabled}
                    tabIndex={disabled ? undefined : 0}
                    title={`Drag to reorder ${control.name} (${shortcut}+↑ / ${shortcut}+↓)`}
                    onPointerDown={(event) => {
                      const target = event.target as HTMLElement | null;
                      dragAllowed.current = !target?.closest(
                        "button, input, textarea, select, a, legend",
                      );
                    }}
                    onDragStart={(event) => {
                      if (disabled || !dragAllowed.current) {
                        event.preventDefault();
                        return;
                      }
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", control.name);
                      setDrag({
                        file: group.path,
                        name: control.name,
                        over: null,
                        side: "before",
                      });
                    }}
                    onDragEnd={() => setDrag(null)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (disabled || !event.altKey) return;
                      if (event.key === "ArrowUp" && index > 0) {
                        event.preventDefault();
                        onMove(
                          group.path,
                          control.name,
                          group.controls[index - 1].name,
                          "before",
                        );
                      }
                      if (
                        event.key === "ArrowDown" &&
                        index < group.controls.length - 1
                      ) {
                        event.preventDefault();
                        onMove(
                          group.path,
                          control.name,
                          group.controls[index + 1].name,
                          "after",
                        );
                      }
                    }}
                    onDragOver={(event) => {
                      if (
                        !drag ||
                        drag.file !== group.path ||
                        drag.name === control.name
                      )
                        return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      const rect = event.currentTarget.getBoundingClientRect();
                      const side =
                        event.clientY < rect.top + rect.height / 2
                          ? "before"
                          : "after";
                      setDrag({ ...drag, over: control.name, side });
                    }}
                    onDragLeave={(event) => {
                      const next = event.relatedTarget as Node | null;
                      if (next && event.currentTarget.contains(next)) return;
                      if (drag?.over === control.name)
                        setDrag({ ...drag, over: null });
                    }}
                    onDrop={(event) => {
                      if (
                        !drag ||
                        drag.file !== group.path ||
                        drag.name === control.name
                      )
                        return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      const side =
                        event.clientY < rect.top + rect.height / 2
                          ? "before"
                          : "after";
                      onMove(group.path, drag.name, control.name, side);
                      setDrag(null);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenu({
                        kind: "control",
                        path: group.path,
                        control,
                        x: Math.min(event.clientX, window.innerWidth - 210),
                        y: Math.min(event.clientY, window.innerHeight - 90),
                      });
                    }}
                  >
                    {peers.size > 1 && (
                      <small className={styles.source} title={group.path}>
                        {sourceLabel(group.path, peers)}
                      </small>
                    )}
                    {control.kind === "number" ? (
                      <NumberKnob
                        control={control}
                        disabled={disabled}
                        onChange={(name, value) =>
                          onChange(group.path, name, value)
                        }
                        onIgnore={(name) => onIgnore(group.path, name)}
                      />
                    ) : (
                      <BooleanSwitch
                        control={control}
                        disabled={disabled}
                        onChange={(name, value) =>
                          onChange(group.path, name, value)
                        }
                        onIgnore={(name) => onIgnore(group.path, name)}
                      />
                    )}
                    {error && (
                      <p role="alert" className={styles.issue}>
                        {error}
                      </p>
                    )}
                  </fieldset>
                );
              })}
            {group.children.map(renderGroup)}
            {!group.controls.length &&
              !group.children.length &&
              !group.error &&
              !group.issues?.length && (
                <p className={styles.controlsEmpty}>
                  No controls in this file.
                </p>
              )}
          </div>
        )}
      </section>
    );
  }
  return (
    <aside className={styles.controlsPanel} aria-label="Snippet controls">
      <div className={styles.controlsTitle}>
        <SlidersHorizontal size={14} />
        <span>Controls</span>
        <button
          type="button"
          className={styles.controllerButton}
          title="Open full controls"
          aria-label="Open full controls"
          disabled={!root || disabled}
          onClick={onOpenController}
        >
          <Maximize2 size={13} />
        </button>
        {loading && <small>Updating…</small>}
      </div>
      <div className={styles.rootHeading}>
        <span title={root ?? undefined}>
          {root?.split("/").at(-1) ?? "No file selected"}
        </span>
        <button
          type="button"
          disabled={!root || disabled}
          className={styles.pin}
          aria-label={pinned ? "Unpin master" : "Pin as master"}
          aria-pressed={pinned}
          title={pinned ? "Unpin master" : "Pin as master"}
          onClick={onPin}
        >
          <Pin size={14} />
        </button>
      </div>
      <input
        className={styles.search}
        aria-label="Search controls"
        placeholder="Search controls or files…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className={styles.controlsList}>
        {tree ? (
          renderGroup(tree)
        ) : (
          <p className={styles.controlsEmpty}>
            {loading
              ? "Loading controls…"
              : "Open a snippet to see its controls."}
          </p>
        )}
        {tree && !contains(tree) && (
          <p className={styles.controlsEmpty}>No matching controls.</p>
        )}
      </div>
      {hidden.length > 0 && (
        <div className={styles.hiddenGroups}>
          <button
            type="button"
            aria-expanded={showHidden}
            onClick={() => setShowHidden(!showHidden)}
          >
            Hidden groups ({hidden.length})
          </button>
          {showHidden &&
            hidden.map((group) => (
              <button
                key={group.id}
                type="button"
                title={JSON.parse(group.id).join(" → ")}
                onClick={() =>
                  onLayout({
                    ...layout,
                    hidden: { ...layout.hidden, [group.id]: false },
                  })
                }
              >
                Restore {JSON.parse(group.id).join(" → ")}
              </button>
            ))}
        </div>
      )}
      <div className={styles.controlsHint}>
        Right-click a control to go to its declaration.
        <br />
        Changes are saved in the source file.
      </div>
      {menu && (
        <div
          role="menu"
          className={styles.menu}
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.kind === "control" ? (
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => {
                onDefinition(menu.path, menu.control.name);
                setMenu(null);
              }}
            >
              Go to declaration
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onLayout({
                  ...layout,
                  hidden: { ...layout.hidden, [menu.group.id]: true },
                });
                setMenu(null);
              }}
            >
              Hide group
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
