import { redo, selectAll, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import type { CommandId, ShortcutEnvironment } from "../../shared/commands";

export const shortcutEnvironment: ShortcutEnvironment = {
  platform: window.workspace.platform,
  os: /Mac/.test(navigator.platform)
    ? "mac"
    : /Win/.test(navigator.platform)
      ? "windows"
      : "linux",
};

export function focusedEditor() {
  const element = document.activeElement?.closest(".cm-editor");
  return element ? EditorView.findFromDOM(element as HTMLElement) : null;
}

export function executeEditingCommand(command: CommandId) {
  const editor = focusedEditor();
  if (
    editor &&
    (command === "undo" || command === "redo" || command === "selectAll")
  ) {
    return { undo, redo, selectAll }[command](editor);
  }
  if (command === "paste") {
    // Web clipboard reads require a user gesture and browser permission.
    return navigator.clipboard.readText().then((text) => {
      if (editor) editor.dispatch(editor.state.replaceSelection(text));
      else document.execCommand("insertText", false, text);
    });
  }
  return document.execCommand(command);
}
