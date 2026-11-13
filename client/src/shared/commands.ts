export type CommandId =
  | "newProject"
  | "openProject"
  | "newFile"
  | "renameFile"
  | "newFolder"
  | "exportProject"
  | "save"
  | "closeTab"
  | "play"
  | "stop"
  | "stopAll"
  | "assist"
  | "sidebar"
  | "controls"
  | "graph"
  | "help"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "controlUp"
  | "controlDown";

export type ShortcutEnvironment = {
  platform: "desktop" | "web";
  os: "mac" | "windows" | "linux";
};

export interface AppCommand {
  id: CommandId;
  label: string;
  code?: string;
  key?: string;
  shift?: boolean;
  alt?: boolean;
  desktopOnly?: boolean;
  webOnly?: boolean;
  edit?: boolean;
}

export const commandMenus: { label: string; commands: AppCommand[] }[] = [
  {
    label: "File",
    commands: [
      { id: "newProject", label: "New Project…" },
      { id: "openProject", label: "Open Project…" },
      { id: "newFile", label: "New Snippet", code: "KeyN", key: "N" },
      { id: "renameFile", label: "Rename Snippet…", code: "KeyR", key: "R" },
      { id: "newFolder", label: "New Folder…" },
      { id: "exportProject", label: "Export Project…", webOnly: true },
      { id: "save", label: "Save", code: "KeyS", key: "S" },
      { id: "closeTab", label: "Close Tab", code: "KeyW", key: "W" },
    ],
  },
  {
    label: "Edit",
    commands: [
      { id: "undo", label: "Undo", edit: true },
      { id: "redo", label: "Redo", edit: true },
      { id: "cut", label: "Cut", edit: true },
      { id: "copy", label: "Copy", edit: true },
      { id: "paste", label: "Paste", edit: true },
      { id: "selectAll", label: "Select All", edit: true },
    ],
  },
  {
    label: "Playback",
    commands: [
      { id: "play", label: "Play / Update", code: "Enter", key: "Enter" },
      { id: "stop", label: "Stop Current", code: "Period", key: "." },
      {
        id: "stopAll",
        label: "Stop All",
        code: "Period",
        key: ".",
        shift: true,
      },
    ],
  },
  {
    label: "Assistant",
    commands: [{ id: "assist", label: "Ask Assist", code: "Comma", key: "," }],
  },
  {
    label: "View",
    commands: [
      { id: "sidebar", label: "Toggle Sidebar", code: "KeyB", key: "B" },
      {
        id: "controls",
        label: "Toggle Controls",
        code: "KeyB",
        key: "B",
        alt: true,
      },
      { id: "graph", label: "Open Graph View" },
    ],
  },
  { label: "Help", commands: [{ id: "help", label: "Wien Help" }] },
];

// Contextual shortcuts remain available without separate top-level menus.
export const commands: AppCommand[] = [
  ...commandMenus.flatMap((menu) => menu.commands),
  { id: "controlUp", label: "Move Control Up", code: "ArrowUp", key: "Up" },
  {
    id: "controlDown",
    label: "Move Control Down",
    code: "ArrowDown",
    key: "Down",
  },
];

export function primaryModifier(environment: ShortcutEnvironment) {
  if (environment.platform === "desktop" && environment.os === "mac")
    return "Meta";
  if (environment.platform === "web" && environment.os === "windows")
    return "Alt";
  return "Control";
}

export function shortcutLabel(
  command: AppCommand,
  environment: ShortcutEnvironment,
) {
  if (command.edit) {
    const mac = environment.os === "mac";
    const keys: Partial<Record<CommandId, string>> = {
      undo: "Z",
      redo: mac ? "Shift + Z" : "Y",
      cut: "X",
      copy: "C",
      paste: "V",
      selectAll: "A",
    };
    return `${mac ? "⌘" : "Ctrl"} + ${keys[command.id]}`;
  }
  if (!command.key) return "";
  const modifier = primaryModifier(environment);
  const extra = command.alt
    ? modifier === "Alt"
      ? " + Ctrl"
      : environment.os === "mac"
        ? " + ⌥"
        : " + Alt"
    : "";
  return `${modifier === "Meta" ? "⌘" : modifier === "Control" ? "Ctrl" : "Alt"}${extra}${command.shift ? " + Shift" : ""} + ${command.key}`;
}

export function matchCommand(
  event: Pick<
    KeyboardEvent,
    | "code"
    | "metaKey"
    | "ctrlKey"
    | "altKey"
    | "shiftKey"
    | "isComposing"
    | "getModifierState"
  >,
  environment: ShortcutEnvironment,
) {
  if (event.isComposing || event.getModifierState("AltGraph")) return;
  const modifier = primaryModifier(environment);
  return commands.find(
    (command) =>
      command.code === event.code &&
      Boolean(command.shift) === event.shiftKey &&
      event.metaKey === (modifier === "Meta") &&
      event.ctrlKey ===
      (modifier === "Control" ||
        (modifier === "Alt" && Boolean(command.alt))) &&
      event.altKey === (modifier === "Alt" || Boolean(command.alt)),
  );
}

export type CommandState = Partial<Record<CommandId, boolean>>;
