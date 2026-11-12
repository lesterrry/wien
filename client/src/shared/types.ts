import type { AssistRequest, AssistResponse } from "./assistant";
import type { PanelPreferences } from "./control-tree";
import type { ModuleGraph } from "./modules";

export interface Entry {
  id: string;
  name: string;
  children?: Entry[];
  exported?: boolean;
}

export interface Project {
  root: string;
  name: string;
  entries: Entry[];
}

export interface SaveRequest {
  path: string;
  content: string;
  expected: string;
}

export interface VersionEntry {
  oid: string;
  message: string;
  timestamp: number;
}

export interface WorkspaceApi {
  versions(): Promise<VersionEntry[]>;
  createVersion(message: string): Promise<void>;
  selectVersion(oid: string): Promise<void>;
  versionActive(): Promise<boolean>;
  versionChanged(): Promise<boolean>;
  restoreVersion(): Promise<void>;
  restoreLatestVersion(oid: string): Promise<void>;
  assist(id: string, request: AssistRequest): Promise<AssistResponse>;
  cancelAssist(id: string): void;
  readControlPreferences(projectRoot: string): Promise<PanelPreferences | null>;
  saveControlPreferences(
    projectRoot: string,
    preferences: PanelPreferences,
  ): Promise<void>;
  current(): Promise<Project>;
  open(): Promise<Project | null>;
  create(): Promise<Project | null>;
  read(path: string): Promise<string>;
  save(request: SaveRequest): Promise<void>;
  graph(path: string, code: string): Promise<ModuleGraph>;
  toggleExport(path: string): Promise<void>;
  link(source: string, target: string): Promise<string>;
  add(parent: string, name: string, folder: boolean): Promise<string>;
  move(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
  reveal(): Promise<void>;
  openExternalLink(url: string): Promise<void>;
  close(): void;
  onBeforeClose(callback: () => void): () => void;
  finishClose(): void;
  cancelClose(): void;
}

export const isWithin = (path: string, parent: string) =>
  path === parent || path.startsWith(`${parent}/`);

export const parentPath = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

export const joinPath = (parent: string, name: string) =>
  parent ? `${parent}/${name}` : name;
