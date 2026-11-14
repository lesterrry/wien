import { useEffect, useRef, useState } from "react";
import {
  type CommandId,
  type CommandState,
  matchCommand,
} from "../../../../shared/commands";
import { shortcutEnvironment } from "../../commands";

const api = window.workspace;

export function useWorkspaceCommands(
  onCommand: (command: CommandId) => void,
  getState: (available: boolean) => CommandState,
) {
  const [menuState, setMenuState] = useState<CommandState>({});
  const lastMenuState = useRef("");
  const commandHandler = useRef(onCommand);
  commandHandler.current = onCommand;
  const stateHandler = useRef(getState);
  stateHandler.current = getState;
  useEffect(
    () => api.onMenuCommand?.((command) => commandHandler.current(command)),
    [],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = matchCommand(event, shortcutEnvironment);
      if (!command) return;
      if (
        (command.id === "controlUp" || command.id === "controlDown") &&
        (!(event.target instanceof HTMLElement) ||
          !event.target.matches("[data-control-move]"))
      )
        return;
      // Enter in the assistant composer belongs to its form.
      if (
        command.id === "play" &&
        event.target instanceof Element &&
        event.target.closest("[data-assistant]")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) commandHandler.current(command.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  useEffect(() => {
    const syncMenu = () => {
      if (
        window.document.activeElement?.closest(
          '[aria-label="Application menu"]',
        )
      )
        return;
      const available = !window.document.querySelector("dialog[open]");
      const state = stateHandler.current(available);
      const serialized = JSON.stringify(state);
      if (lastMenuState.current === serialized) return;
      lastMenuState.current = serialized;
      api.updateMenuState?.(state);
      setMenuState(state);
    };
    syncMenu();
    window.addEventListener("focusin", syncMenu);
    const observer = new MutationObserver((mutations) => {
      if (
        mutations.some(
          (mutation) =>
            mutation.type === "attributes" ||
            [...mutation.addedNodes, ...mutation.removedNodes].some(
              (node) =>
                node instanceof Element &&
                (node.matches("dialog") || node.querySelector("dialog")),
            ),
        )
      )
        syncMenu();
    });
    observer.observe(window.document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => {
      window.removeEventListener("focusin", syncMenu);
      observer.disconnect();
    };
  });

  return {
    menuState,
    dispatchCommand: (command: CommandId) => commandHandler.current(command),
  };
}
