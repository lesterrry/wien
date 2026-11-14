import { AccountClient } from "../shared/account-client";
import {
  AssistAccessError,
  requestAssistant,
} from "../shared/assistant-client";
import { validateWav, wavFilename } from "../shared/audio-export";
import { exampleNames, getExampleFiles } from "../shared/examples";
import { externalWebUrl } from "../shared/links";
import type { WorkspaceApi } from "../shared/types";
import { pickProject } from "./ProjectPicker";
import { BrowserProjects } from "./projects";

const projects = new BrowserProjects();
const account = new AccountClient("", null);
const requests = new Map<string, AbortController>();
async function choose(create: boolean, example?: string) {
  const files = getExampleFiles(example ?? "default");
  const existing = await projects.list();
  if (
    create &&
    example &&
    !existing.some((project) => project.name === example)
  ) {
    return projects.create(example, files);
  }
  const choice = await pickProject(existing, create, example);
  if (!choice) return null;
  if (choice.kind === "create") return projects.create(choice.name, files);
  if (choice.kind === "import") return projects.import(choice.content);
  return projects.select(choice.id);
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("Request cancelled."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
export const workspace: WorkspaceApi = {
  platform: "web",
  accountCurrent: () => account.current(),
  accountRegister: (credentials) => account.register(credentials),
  accountLogin: (credentials) => account.login(credentials),
  accountLogout: () => account.logout(),
  accountChangePassword: (request) => account.changePassword(request),
  current: () => projects.current(),
  onProjectChanged: (callback) => projects.onChanged(callback),
  open: () => choose(false),
  examples: async () => [...exampleNames],
  create: (example) => choose(true, example),
  read: (path) => projects.readFile(path),
  save: (request) => projects.save(request),
  graph: (path, code) => projects.graph(path, code),
  toggleExport: (path) => projects.toggleExport(path),
  link: (source, target) => projects.link(source, target),
  add: (parent, name, folder) => projects.add(parent, name, folder),
  move: (from, to) => projects.move(from, to),
  trash: (path) => projects.trash(path),
  readControlPreferences: (root) => projects.preferences(root),
  saveControlPreferences: (root, value) =>
    projects.savePreferences(root, value),
  async saveAudio(name, data) {
    validateWav(data);
    const url = URL.createObjectURL(new Blob([data], { type: "audio/wav" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = wavFilename(name);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return true;
  },
  async exportProject() {
    const project = await projects.export();
    const url = URL.createObjectURL(
      new Blob([project.content], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${project.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.wien.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  async assist(id, request) {
    const controller = new AbortController();
    requests.set(id, controller);
    try {
      return await requestAssistant(
        request,
        controller.signal,
        { url: "", local: false, token: null, cookie: true },
        delay,
      );
    } catch (error) {
      if (error instanceof AssistAccessError) return { action: error.action };
      throw error;
    } finally {
      requests.delete(id);
    }
  },
  cancelAssist: (id) => requests.get(id)?.abort(),
  versions: async () => [],
  createVersion: async () => {
    throw new Error("Versions are not available in the web app.");
  },
  selectVersion: async () => {
    throw new Error("Versions are not available in the web app.");
  },
  versionActive: async () => false,
  versionChanged: async () => false,
  restoreVersion: async () => {},
  reveal: async () => {},
  openExternalLink: async (value) => {
    const url = externalWebUrl(value);
    if (!url) throw new Error("Only HTTP and HTTPS links can be opened.");
    window.open(url, "_blank", "noopener,noreferrer");
  },
  close: () => {},
  onBeforeClose: () => () => {},
  finishClose: () => {},
  cancelClose: () => {},
};
