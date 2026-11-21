import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";
import {
  type CommandId,
  type CommandState,
  commandMenus,
  commands,
} from "../shared/commands";

import { t } from "./locale";

export function installMenu() {
  const template: MenuItemConstructorOptions[] = commandMenus.map((group) => ({
    label: t(group.label),
    submenu: group.commands
      .filter((command) => !command.webOnly)
      .map((command): MenuItemConstructorOptions => {
        if (command.edit)
          return {
            label: t(command.label),
            role: command.id as
              | "undo"
              | "redo"
              | "cut"
              | "copy"
              | "paste"
              | "selectAll",
          };
        return {
          id: command.id,
          label: t(command.label),
          enabled: false,
          accelerator: command.key
            ? `CommandOrControl+${command.alt ? "Alt+" : ""}${command.shift ? "Shift+" : ""}${command.key}`
            : undefined,
          // The renderer owns shortcut dispatch, including modal and focus guards.
          // Keep accelerators visible without invoking a command twice.
          registerAccelerator: false,
          acceleratorWorksWhenHidden: false,
          click: () =>
            BrowserWindow.getFocusedWindow()?.webContents.send(
              "menu:command",
              command.id,
            ),
        };
      }),
  }));
  const view = template.find((item) => item.label === t("View"));
  if (view && Array.isArray(view.submenu))
    view.submenu.push(
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
      ...(!app.isPackaged ? [{ role: "toggleDevTools" as const }] : []),
    );
  if (process.platform === "darwin") template.unshift({ role: "appMenu" });
  template.splice(template.length - 1, 0, { role: "windowMenu" });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function updateMenuState(state: CommandState) {
  const menu = Menu.getApplicationMenu();
  for (const command of commands) {
    if (command.edit) continue;
    const item = menu?.getMenuItemById(command.id);
    if (item) item.enabled = state[command.id as CommandId] === true;
  }
}
