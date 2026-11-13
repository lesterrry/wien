import { useEffect, useRef, useState } from "react";
import {
  type CommandId,
  type CommandState,
  commandMenus,
  shortcutLabel,
} from "../../../../shared/commands";
import { shortcutEnvironment } from "../../commands";
import styles from "./AppMenu.module.css";

export function AppMenu({
  onCommand,
  state,
}: {
  onCommand: (command: CommandId) => void;
  state: CommandState;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const root = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const menus = commandMenus.map((menu) => ({
    ...menu,
    commands: menu.commands.filter((command) => !command.desktopOnly),
  }));
  function close(restore = true) {
    setOpen(null);
    if (restore) previousFocus.current?.focus();
  }
  useEffect(() => {
    if (open === null) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (open !== null)
      root.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
  }, [open]);
  return (
    <nav className={styles.bar} aria-label="Application menu" ref={root}>
      {menus.map((menu, index) => (
        <div className={styles.group} key={menu.label}>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open === index}
            onPointerDown={(event) => {
              if (open === null)
                previousFocus.current = document.activeElement as HTMLElement;
              event.preventDefault();
            }}
            onClick={() => (open === index ? close() : setOpen(index))}
            onKeyDown={(event) => {
              if (["ArrowDown", "Enter", " "].includes(event.key)) {
                event.preventDefault();
                if (open === null)
                  previousFocus.current = document.activeElement as HTMLElement;
                setOpen(index);
              }
            }}
          >
            {menu.label}
          </button>
          {open === index && (
            <div
              role="menu"
              aria-label={menu.label}
              className={styles.dropdown}
              onKeyDown={(event) => {
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                );
                const current = items.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                } else if (event.key === "Tab") close(false);
                else if (
                  event.key === "ArrowRight" ||
                  event.key === "ArrowLeft"
                ) {
                  event.preventDefault();
                  setOpen(
                    (index +
                      (event.key === "ArrowRight" ? 1 : -1) +
                      menus.length) %
                      menus.length,
                  );
                } else if (
                  ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
                ) {
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : (current +
                            (event.key === "ArrowDown" ? 1 : -1) +
                            items.length) %
                          items.length;
                  items[next]?.focus();
                }
              }}
            >
              {menu.commands.map((command) => (
                <button
                  key={command.id}
                  type="button"
                  role="menuitem"
                  disabled={state[command.id] === false}
                  onClick={() => {
                    close();
                    onCommand(command.id);
                  }}
                >
                  <span>{command.label}</span>
                  <kbd>{shortcutLabel(command, shortcutEnvironment)}</kbd>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
