import {
  ArrowDownToLine,
  ArrowRight,
  CircleHelp,
  FilePlus2,
  FolderPlus,
  Network,
  Search,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import styles from "./WorkspaceSidebar.module.css";

export function WorkspaceSidebar({
  busy,
  projectReady,
  search,
  onSearch,
  onCreate,
  onGraph,
  onHelp,
  projectMenu,
  explorer,
  versions,
}: {
  busy: boolean;
  projectReady: boolean;
  search: string;
  onSearch: (search: string) => void;
  onCreate: (folder: boolean) => void;
  onGraph: () => void;
  onHelp: () => void;
  projectMenu: ReactNode;
  explorer: ReactNode;
  versions: ReactNode;
}) {
  return (
    <aside className={styles.sidebar}>
      {projectMenu}
      <label className={styles.searchBox}>
        <Search size={14} />
        <input
          aria-label="Find a snippet"
          placeholder="Find a snippet…"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
        {search && (
          <button
            className={styles.iconButton}
            type="button"
            aria-label="Clear search"
            onClick={() => onSearch("")}
          >
            <X size={12} />
          </button>
        )}
      </label>
      <div className={styles.sectionHeading}>
        <span>Files</span>
        <div>
          <button
            className={styles.iconButton}
            type="button"
            title="New snippet"
            aria-label="New snippet"
            disabled={busy}
            onClick={() => onCreate(false)}
          >
            <FilePlus2 size={15} />
          </button>
          <button
            className={styles.iconButton}
            type="button"
            title="New folder"
            aria-label="New folder"
            disabled={busy}
            onClick={() => onCreate(true)}
          >
            <FolderPlus size={15} />
          </button>
        </div>
      </div>
      {explorer}
      {versions}
      {window.workspace.platform === "web" && (
        <a
          className={styles.downloadApp}
          href="https://github.com/lesterrry/wien/releases"
          target="_blank"
          rel="noopener noreferrer"
        >
          <ArrowDownToLine size={16} aria-hidden="true" />
          Скачать приложение
        </a>
      )}
      <div className={styles.sidebarBottom}>
        <button
          type="button"
          className={styles.graphLink}
          onClick={onGraph}
          disabled={!projectReady || busy}
          aria-label="Open Graph View"
        >
          <Network size={16} />
          <span>
            Graph View<small>Explore project dependencies</small>
          </span>
          <ArrowRight size={13} />
        </button>
        <button type="button" className={styles.helpButton} onClick={onHelp}>
          <CircleHelp size={14} />
          Getting started<span>?</span>
        </button>
      </div>
    </aside>
  );
}
