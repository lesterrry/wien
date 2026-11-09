export interface Entry {
  id: string;
  name: string;
  children?: Entry[];
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

export interface WorkspaceApi {
  current(): Promise<Project>;
  open(): Promise<Project | null>;
  create(): Promise<Project | null>;
  read(path: string): Promise<string>;
  save(request: SaveRequest): Promise<void>;
  add(parent: string, name: string, folder: boolean): Promise<string>;
  move(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
  reveal(): Promise<void>;
  close(): void;
  onBeforeClose(callback: () => void): () => void;
  finishClose(): void;
}

export const isWithin = (path: string, parent: string) =>
  path === parent || path.startsWith(`${parent}/`);

export const parentPath = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

export const joinPath = (parent: string, name: string) =>
  parent ? `${parent}/${name}` : name;
