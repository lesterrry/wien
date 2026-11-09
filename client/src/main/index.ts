import * as fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import type { SaveRequest } from "../shared/types";
import { ProjectFs } from "./project-fs";
import { starterFiles } from "./starter";

if (!app.isPackaged && process.env.WIEN_USER_DATA) {
  app.setPath("userData", process.env.WIEN_USER_DATA);
}

let window: BrowserWindow | null = null;
let project: ProjectFs;
let closing = false;

const stateFile = () => path.join(app.getPath("userData"), "workspace.json");

async function selectProject(root: string) {
  const realRoot = await fs.realpath(root);
  const next = new ProjectFs(realRoot);
  const info = await next.project();
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(stateFile(), JSON.stringify({ root: realRoot }));
  project = next;
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
  try {
    const saved = JSON.parse(await fs.readFile(stateFile(), "utf8"));
    await selectProject(saved.root);
    return;
  } catch {
    // Missing or moved project: open the welcome workspace.
  }
  const parent = path.join(app.getPath("userData"), "projects");
  const root = path.join(parent, "First session");
  await fs.mkdir(parent, { recursive: true });
  try {
    await fs.access(root);
    await selectProject(root);
  } catch {
    await createStarter(root);
  }
}

function registerIpc() {
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
  handle("project:current", () => project.project());
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
    if (event.sender === window?.webContents) {
      closing = true;
      window.close();
    }
  });
}

function createWindow() {
  closing = false;
  window = new BrowserWindow({
    width: 1320,
    height: 870,
    minWidth: 850,
    minHeight: 560,
    title: "Wien",
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
      window?.webContents.send("app:before-close");
    }
  });
  window.on("closed", () => {
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
