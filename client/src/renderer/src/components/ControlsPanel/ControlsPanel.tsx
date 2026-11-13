import classNames from "classnames";
import {
  ChevronDown,
  ChevronRight,
  Layers,
  Maximize2,
  Minimize2,
  Pin,
  SlidersHorizontal,
} from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { primaryModifier } from "../../../../shared/commands";
import { hasControlCustomizations } from "../../../../shared/control-customizations";
import { canResetControl } from "../../../../shared/control-defaults";
import {
  type ControlGroup,
  flatPanelLayout,
  flattenControlGroups,
  type PanelLayout,
} from "../../../../shared/control-tree";
import type {
  Control,
  ControlChange,
  ControlValue,
} from "../../../../shared/controls";
import { shortcutEnvironment } from "../../commands";
import { BooleanSwitch } from "../BooleanSwitch/BooleanSwitch";
import { EnumSwitch } from "../EnumSwitch/EnumSwitch";
import { MultiSelect } from "../MultiSelect/MultiSelect";
import { NumberKnob } from "../NumberKnob/NumberKnob";
import { NumberSlider } from "../NumberSlider/NumberSlider";
import styles from "./ControlsPanel.module.css";

interface ControlCallbacks {
  disabled: boolean;
  onChange: (name: string, change: ControlChange) => void;
  onIgnore?: (name: string) => void;
  onDefinition?: (name: string) => void;
  onConfigure?: (name: string) => void;
}

export function ControlInput({
  control,
  disabled,
  onChange,
  onIgnore,
  onDefinition,
  onConfigure,
}: ControlCallbacks & { control: Control }) {
  const props = {
    disabled,
    onIgnore,
    onDefinition,
    onConfigure: hasControlCustomizations(control) ? onConfigure : undefined,
    onReset: canResetControl(control)
      ? () => onChange(control.name, { type: "reset" })
      : undefined,
  };
  const setValue = (name: string, value: ControlValue) =>
    onChange(name, { type: "set", value });
  switch (control.kind) {
    case "multi-enum":
      return <MultiSelect {...props} control={control} onChange={onChange} />;
    case "enum":
      return <EnumSwitch {...props} control={control} onChange={setValue} />;
    case "slider":
      return <NumberSlider {...props} control={control} onChange={setValue} />;
    case "number":
      return <NumberKnob {...props} control={control} onChange={setValue} />;
    case "boolean":
      return <BooleanSwitch {...props} control={control} onChange={setValue} />;
    default: {
      const unsupported: never = control;
      throw new Error(`Unsupported control: ${unsupported}`);
    }
  }
}

export function ControlsPanel({
  tree,
  root,
  pinned,
  loading,
  disabled,
  layout: savedLayout,
  errors,
  onPin,
  onLayout,
  onChange,
  onIgnore,
  onDefinition,
  onConfigure,
  onMove,
  onOpenController,
  onReloadSource,
  fullscreen,
  headerActions,
  visible,
}: {
  fullscreen: boolean;
  headerActions?: ReactNode;
  visible: boolean;
  tree: ControlGroup | null;
  root: string | null;
  pinned: boolean;
  loading: boolean;
  disabled: boolean;
  layout: PanelLayout;
  errors: Record<string, string>;
  onPin: () => void;
  onLayout: (layout: PanelLayout) => void;
  onChange: (path: string, name: string, change: ControlChange) => void;
  onIgnore: (path: string, name: string) => void;
  onDefinition: (path: string, name: string) => void;
  onConfigure: (path: string, name: string) => void;
  onMove: (
    path: string,
    name: string,
    targetName: string,
    placement: "before" | "after",
  ) => void;
  onReloadSource: (path: string) => void;
  onOpenController: () => void;
}) {
  const [drag, setDrag] = useState<{
    file: string;
    name: string;
    over: string | null;
    side: "before" | "after";
  } | null>(null);
  const dragAllowed = useRef(true);
  const list = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef({ sidebar: 0, fullscreen: 0 });
  useLayoutEffect(() => {
    if (list.current)
      list.current.scrollTop =
        scrollPositions.current[fullscreen ? "fullscreen" : "sidebar"];
  }, [fullscreen]);
  const modifier = primaryModifier(shortcutEnvironment);
  const shortcut =
    modifier === "Meta" ? "⌘" : modifier === "Control" ? "Ctrl" : "Alt";
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const groups = tree ? flattenControlGroups(tree) : [];
  const layout = flatPanelLayout(savedLayout, groups);
  const matches = (path: string, name: string) =>
    `${path} ${name}`.toLocaleLowerCase().includes(query);
  function contains(group: ControlGroup): boolean {
    if (!group.controls.length) return false;
    return (
      !query ||
      matches(group.path, "") ||
      group.controls.some((control) => matches(group.path, control.name)) ||
      Boolean(
        group.compositions?.some((composition) =>
          matches(group.path, composition.name),
        ),
      )
    );
  }
  const matchingGroups = groups.filter(contains);
  function renderGroup(group: ControlGroup) {
    if (!contains(group)) return null;
    const collapsed = !query && Boolean(layout.collapsed[group.id]);
    const ungrouped = group.controls.filter(
      (control) =>
        !group.compositions?.some((item) =>
          item.members.includes(control.name),
        ),
    );
    function renderControl(control: Control, siblings: Control[]) {
      const index = siblings.indexOf(control);
      const isOver =
        drag?.file === group.path &&
        drag?.over === control.name &&
        drag.name !== control.name;
      const error = errors[JSON.stringify([group.path, control.name])];
      return (
        <fieldset
          key={control.name}
          className={classNames(styles.controlRow, styles.control, {
            [styles.rowDragging]:
              drag?.file === group.path && drag?.name === control.name,
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
          data-control-move=""
          data-move-up={!disabled && index > 0}
          data-move-down={!disabled && index < siblings.length - 1}
          ref={(node) => {
            if (!node) return;
            const move = (event: Event) => {
              if (disabled) return;
              const direction = (event as CustomEvent<string>).detail;
              if (direction === "up" && index > 0)
                onMove(
                  group.path,
                  control.name,
                  siblings[index - 1].name,
                  "before",
                );
              if (direction === "down" && index < siblings.length - 1)
                onMove(
                  group.path,
                  control.name,
                  siblings[index + 1].name,
                  "after",
                );
            };
            node.addEventListener("wien:move-control", move);
            return () => node.removeEventListener("wien:move-control", move);
          }}
          onDragOver={(event) => {
            if (
              !drag ||
              drag.file !== group.path ||
              drag.name === control.name ||
              !siblings.some((item) => item.name === drag.name)
            )
              return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const rect = event.currentTarget.getBoundingClientRect();
            const side =
              event.clientY < rect.top + rect.height / 2 ? "before" : "after";
            setDrag({ ...drag, over: control.name, side });
          }}
          onDragLeave={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next && event.currentTarget.contains(next)) return;
            if (drag?.over === control.name) setDrag({ ...drag, over: null });
          }}
          onDrop={(event) => {
            if (
              !drag ||
              drag.file !== group.path ||
              drag.name === control.name ||
              !siblings.some((item) => item.name === drag.name)
            )
              return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const side =
              event.clientY < rect.top + rect.height / 2 ? "before" : "after";
            onMove(group.path, drag.name, control.name, side);
            setDrag(null);
          }}
        >
          <ControlInput
            control={control}
            disabled={disabled}
            onChange={(name, change) => onChange(group.path, name, change)}
            onIgnore={(name) => onIgnore(group.path, name)}
            onDefinition={(name) => onDefinition(group.path, name)}
            onConfigure={(name) => onConfigure(group.path, name)}
          />
          {error && (
            <p role="alert" className={styles.issue}>
              {error}
              <button
                type="button"
                disabled={disabled}
                onClick={() => onReloadSource(group.path)}
              >
                Reload source…
              </button>
            </p>
          )}
        </fieldset>
      );
    }
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
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <span>
            <span className={styles.parentPath}>
              {group.path.slice(0, group.path.lastIndexOf("/") + 1)}
            </span>
            {group.path.split("/").at(-1)}
          </span>
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
            {Object.entries(errors).map(([key, message]) => {
              const [path, name] = JSON.parse(key) as [string, string];
              if (
                path !== group.path ||
                group.controls.some((control) => control.name === name)
              )
                return null;
              return (
                <p key={key} role="alert" className={styles.issue}>
                  <strong>{name}</strong>: {message}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onReloadSource(group.path)}
                  >
                    Reload source…
                  </button>
                </p>
              );
            })}
            <div className={styles.groupControls}>
              {group.controls.map((control) => {
                const composition = group.compositions?.find((item) =>
                  item.members.includes(control.name),
                );
                if (!composition)
                  return matches(group.path, control.name)
                    ? renderControl(control, ungrouped)
                    : null;
                const members = composition.members.flatMap((name) =>
                  group.controls.filter((item) => item.name === name),
                );
                if (
                  group.controls.find((item) =>
                    composition.members.includes(item.name),
                  ) !== control
                )
                  return null;
                const shown = members.filter(
                  (item) =>
                    matches(group.path, composition.name) ||
                    matches(group.path, item.name),
                );
                if (!shown.length) return null;
                return (
                  <section
                    key={composition.name}
                    className={styles.composition}
                    aria-label={`${composition.name} control group`}
                  >
                    <button
                      type="button"
                      onClick={() => onDefinition(group.path, composition.name)}
                      className={styles.compositionHeading}
                      title={composition.name}
                    >
                      <span>{composition.name}</span>
                      <Layers size={12} aria-hidden="true" />
                    </button>
                    {shown.map((item) => renderControl(item, members))}
                  </section>
                );
              })}
            </div>
          </div>
        )}
      </section>
    );
  }
  return (
    <aside
      className={classNames(styles.controlsPanel, {
        [styles.fullscreen]: fullscreen,
      })}
      aria-label="Snippet controls"
      data-mode={fullscreen ? "fullscreen" : "sidebar"}
      hidden={!visible}
    >
      <div className={styles.controlsTitle}>
        <SlidersHorizontal size={14} />
        <span>Controls</span>
        {loading && <small>Updating…</small>}
        {headerActions}
        <button
          type="button"
          className={styles.controllerButton}
          title={fullscreen ? "Exit fullscreen" : "Open full controls"}
          aria-label={fullscreen ? "Exit fullscreen" : "Open full controls"}
          disabled={!fullscreen && (!root || disabled)}
          onClick={onOpenController}
        >
          {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
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
      {groups.some((group) => group.controls.length > 0) && (
        <input
          className={styles.search}
          aria-label="Search controls"
          placeholder="Search controls or files…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      )}
      <div
        className={styles.controlsList}
        ref={list}
        onScroll={(event) => {
          scrollPositions.current[fullscreen ? "fullscreen" : "sidebar"] =
            event.currentTarget.scrollTop;
        }}
      >
        {tree ? (
          <div className={styles.groups}>{matchingGroups.map(renderGroup)}</div>
        ) : (
          <p className={styles.controlsEmpty}>
            {loading
              ? "Loading controls…"
              : "Open a snippet to see its controls."}
          </p>
        )}
        {groups
          .filter(
            (group) =>
              !group.controls.length && (group.error || group.issues?.length),
          )
          .map((group) => (
            <div key={group.id}>
              {group.error && (
                <p role="alert" className={styles.issue}>
                  {group.path}: {group.error}
                </p>
              )}
              {group.issues?.map((issue) => (
                <p key={issue.name} role="alert" className={styles.issue}>
                  {group.path} · <strong>{issue.name}</strong>: {issue.message}
                </p>
              ))}
            </div>
          ))}
        {tree && !matchingGroups.length && (
          <p className={styles.controlsEmpty}>
            {query ? "No matching controls." : "No controls in these files."}
          </p>
        )}
      </div>
      <div className={styles.controlsHint}>
        Click control title to go to its declaration
      </div>
    </aside>
  );
}
