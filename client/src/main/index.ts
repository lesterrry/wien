import * as fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import type { AssistRequest } from "../shared/assistant";
import { externalWebUrl } from "../shared/links";
import type { SaveRequest } from "../shared/types";
import { AccountClient } from "./account";
import { AccountStorage } from "./account-storage";
import { AssistAccessError, askAssistant } from "./assistant";
import { backendConfig } from "./config";
import { ProjectFs } from "./project-fs";
import { ProjectVersions } from "./project-versions";
import { starterFiles } from "./starter";

if (!app.isPackaged && process.env.WIEN_USER_DATA) {
  app.setPath("userData", process.env.WIEN_USER_DATA);
}

let window: BrowserWindow | null = null;
let project: ProjectFs;
let versions: ProjectVersions;
let versionUnavailable: string | null = null;
let closing = false;
let closePending = false;
let quitting = false;
let assistantRequest: { id: string; controller: AbortController } | null = null;

const icon = path.join(__dirname, "../../resources/icon.png");

const stateFile = () => path.join(app.getPath("userData"), "workspace.json");

async function selectProject(root: string) {
  const realRoot = await fs.realpath(root);
  const next = new ProjectFs(realRoot);
  const nextVersions = new ProjectVersions(realRoot, app.getPath("userData"));
  let savedHistory: string | undefined;
  let recoveryError: string | null = null;
  try {
    savedHistory = await nextVersions.recover(true);
  } catch (error) {
    recoveryError = `Version recovery is unavailable: ${String(error)}. The recovery copy has been retained.`;
  }
  if (savedHistory) {
    await dialog.showMessageBox({
      type: "info",
      title: "Project recovered",
      message: "The working state was restored.",
      detail: `Files changed during the interrupted version view were preserved at ${savedHistory}.`,
    });
  }
  const info = await next.project();
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(stateFile(), JSON.stringify({ root: realRoot }));
  project = next;
  versions = nextVersions;
  versionUnavailable = recoveryError;
  return info;
}

async function createStarter(root: string) {
  await fs.mkdir(root);
  for (const [relative, code] of Object.entries(starterFiles)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, code, { flag: "wx" });
  }
  return selectProject(root);
}

async function initializeProject() {
  if (!app.isPackaged && process.env.WIEN_PROJECT) {
    return selectProject(process.env.WIEN_PROJECT);
  }
  let savedRoot: string | undefined;
  try {
    const saved = JSON.parse(await fs.readFile(stateFile(), "utf8"));
    if (typeof saved.root === "string") {
      await fs.access(saved.root);
      savedRoot = saved.root;
    }
  } catch {
    // Missing or moved project: open the welcome workspace.
  }
  if (savedRoot) {
    await selectProject(savedRoot);
    return;
  }
  const parent = path.join(app.getPath("userData"), "projects");
  const root = path.join(parent, "First session");
  await fs.mkdir(parent, { recursive: true });
  const exists = await fs.access(root).then(
    () => true,
    () => false,
  );
  if (exists) await selectProject(root);
  else await createStarter(root);
}

function registerIpc() {
  const origin = backendConfig().url;
  const accountStorage = new AccountStorage(app.getPath("userData"), origin);
  const account = new AccountClient(origin, accountStorage);
  let accountQueue: Promise<unknown> = Promise.resolve();
  const accountHandlers = {
    "account:current": () => account.current(),
    "account:register": (value: Parameters<AccountClient["register"]>[0]) =>
      account.register(value),
    "account:login": (value: Parameters<AccountClient["login"]>[0]) =>
      account.login(value),
    "account:logout": () => account.logout(),
    "account:password": (
      value: Parameters<AccountClient["changePassword"]>[0],
    ) => account.changePassword(value),
  };
  for (const [channel, action] of Object.entries(accountHandlers)) {
    ipcMain.handle(channel, (event, value) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Invalid account request.");
      const result = accountQueue.then<unknown>(() => action(value));
      accountQueue = result.catch(() => {});
      return result;
    });
  }
  // Network requests must not block the serialized filesystem/autosave queue.
  ipcMain.handle(
    "assistant:send",
    async (event, id: string, request: AssistRequest) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Invalid assistant request.");
      if (typeof id !== "string" || id.length > 100)
        throw new Error("Invalid request ID.");
      if (assistantRequest)
        throw new Error("An assistant request is already running.");
      const current = { id, controller: new AbortController() };
      assistantRequest = current;
      let token: string | null = null;
      try {
        token = await accountStorage.read();
        return await askAssistant(request, current.controller.signal, token);
      } catch (error) {
        if (error instanceof AssistAccessError) {
          if (
            error.action === "sign_in" &&
            (await accountStorage.read()) === token
          )
            await accountStorage.write(null);
          return { action: error.action };
        }
        throw error;
      } finally {
        if (assistantRequest === current) assistantRequest = null;
      }
    },
  );
  ipcMain.on("assistant:cancel", (event, id: string) => {
    if (
      event.sender === window?.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      assistantRequest?.id === id
    ) {
      assistantRequest.controller.abort();
      assistantRequest = null;
    }
  });
  // Serialize IO so autosaves, renames and project switches cannot race.
  let queue: Promise<unknown> = Promise.resolve();
  const handle = (channel: string, action: (...args: never[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      ) {
        throw new Error("Invalid workspace request.");
      }
      const result = queue.then(() => action(...(args as never[])));
      queue = result.catch(() => {});
      return result;
    });
  };
  handle("project:controls:read", (root: string) => {
    if (root !== project.root)
      throw new Error("The project changed before reading panel settings.");
    return project.readControlPreferences();
  });
  handle("project:controls:save", (root: string, preferences: unknown) => {
    if (root !== project.root)
      throw new Error("The project changed before saving panel settings.");
    return project.saveControlPreferences(preferences);
  });
  handle("project:current", () => project.project());
  const availableVersions = () => {
    if (versionUnavailable) throw new Error(versionUnavailable);
    return versions;
  };
  handle("versions:list", () => availableVersions().list());
  handle("versions:create", (message: string) =>
    availableVersions().create(message),
  );
  handle("versions:select", (oid: string) => availableVersions().select(oid));
  handle("versions:active", () => versions.active());
  handle("versions:changed", () => versions.changed());
  handle("versions:restore", () => versions.recover());
  handle("project:read", (relative: string) => project.read(relative));
  handle("project:save", (request: SaveRequest) => project.save(request));
  handle("project:graph", (path: string, code: string) =>
    project.graph(path, code),
  );
  handle("project:toggle-export", (path: string) => project.toggleExport(path));
  handle("project:link", (source: string, target: string) =>
    project.link(source, target),
  );
  handle("project:add", (parent: string, name: string, folder: boolean) =>
    project.add(parent, name, folder),
  );
  handle("project:move", (from: string, to: string) => project.move(from, to));
  handle("project:trash", (relative: string) =>
    project.trash(relative, shell.trashItem),
  );
  handle("project:reveal", () => shell.openPath(project.root));
  handle("app:open-external-link", (value: string) => {
    const url = externalWebUrl(value);
    if (!url) throw new Error("Only HTTP and HTTPS links can be opened.");
    return shell.openExternal(url);
  });
  handle("project:open", async () => {
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      title: "Open a music project",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : selectProject(result.filePaths[0]);
  });
  handle("project:create", async () => {
    if (!window) return null;
    const result = await dialog.showSaveDialog(window, {
      title: "Create a music project",
      buttonLabel: "Create project",
      defaultPath: path.join(app.getPath("documents"), "Untitled session"),
      properties: ["createDirectory"],
    });
    if (result.canceled || !result.filePath) return null;
    return createStarter(result.filePath);
  });
  ipcMain.on("app:close", (event) => {
    if (event.sender === window?.webContents) window.close();
  });
  ipcMain.on("app:close-ready", (event) => {
    if (event.sender === window?.webContents && closePending) {
      closePending = false;
      closing = true;
      if (quitting) app.quit();
      else window.close();
    }
  });
  ipcMain.on("app:close-cancelled", (event) => {
    if (event.sender === window?.webContents) {
      closePending = false;
      quitting = false;
    }
  });
}

function createWindow() {
  closing = false;
  closePending = false;
  quitting = false;
  window = new BrowserWindow({
    width: 1320,
    height: 870,
    minWidth: 850,
    minHeight: 560,
    title: "Wien",
    icon,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 19 },
    backgroundColor: "#191919",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.on("close", (event) => {
    if (!closing && !window?.webContents.isDestroyed()) {
      event.preventDefault();
      if (!closePending) {
        closePending = true;
        window?.webContents.send("app:before-close");
      }
    }
  });
  window.on("closed", () => {
    assistantRequest?.controller.abort();
    assistantRequest = null;
    window = null;
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

void app
  .whenReady()
  .then(async () => {
    // Packaged macOS apps use their native Icon Composer asset and system appearance.
    if (process.platform === "darwin" && !app.isPackaged)
      app.dock?.setIcon(icon);
    await initializeProject();
    registerIpc();
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === "darwin"
          ? [{ role: "appMenu" as const }]
          : []),
        { label: "File", submenu: [{ role: "close" }] },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ]),
    );
    createWindow();
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
  })
  .catch((error) => {
    dialog.showErrorBox("Wien could not start", String(error));
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (!window || closing || window.webContents.isDestroyed()) return;
  // Keep Quit distinct from closing a macOS window: resume app.quit() after
  // the renderer has saved, instead of only resuming window.close().
  event.preventDefault();
  quitting = true;
  window.close();
});
