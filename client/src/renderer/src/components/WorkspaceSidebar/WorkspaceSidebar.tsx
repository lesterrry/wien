import {
  ArrowDownToLine,
  ArrowRight,
  CircleHelp,
  FilePlus2,
  FileText,
  FolderPlus,
  Globe,
  Network,
  Search,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { setLocale, t, useLocale } from "../../i18n";
import styles from "./WorkspaceSidebar.module.css";

export function WorkspaceSidebar({
  busy,
  projectReady,
  search,
  onSearch,
  onCreate,
  onGraph,
  onHelp,
  onTerms,
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
  onTerms: () => void;
  projectMenu: ReactNode;
  explorer: ReactNode;
  versions: ReactNode;
}) {
  const locale = useLocale();
  return (
    <aside className={styles.sidebar}>
      {projectMenu}
      <label className={styles.searchBox}>
        <Search size={14} />
        <input
          aria-label={t("Find a snippet")}
          placeholder={t("Find a snippet…")}
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
        {search && (
          <button
            className={styles.iconButton}
            type="button"
            aria-label={t("Clear search")}
            onClick={() => onSearch("")}
          >
            <X size={12} />
          </button>
        )}
      </label>
      <div className={styles.sectionHeading}>
        <span>{t("Files")}</span>
        <div>
          <button
            className={styles.iconButton}
            type="button"
            title={t("New snippet")}
            aria-label={t("New snippet")}
            disabled={busy}
            onClick={() => onCreate(false)}
          >
            <FilePlus2 size={15} />
          </button>
          <button
            className={styles.iconButton}
            type="button"
            title={t("New folder")}
            aria-label={t("New folder")}
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
          {t("Скачать приложение")}
        </a>
      )}
      <div className={styles.sidebarBottom}>
        <button
          type="button"
          className={styles.graphLink}
          onClick={onGraph}
          disabled={!projectReady || busy}
          aria-label={t("Open Graph View")}
        >
          <Network size={16} />
          <span>
            {t("Graph View")}
            <small>{t("Explore project dependencies")}</small>
          </span>
          <ArrowRight size={13} />
        </button>
        <button type="button" className={styles.helpButton} onClick={onTerms}>
          <FileText size={14} aria-hidden="true" />
          {t("Тарифы и условия")}
        </button>
        <button type="button" className={styles.helpButton} onClick={onHelp}>
          <CircleHelp size={14} />
          {t("Getting started")}
        </button>
        <fieldset
          className={styles.languageSwitcher}
          aria-label={t("Language")}
        >
          <Globe size={14} aria-hidden="true" />
          <span>{t("Language")}</span>
          <div className={styles.languageOptions}>
            {(["en", "ru"] as const).map((language) => (
              <button
                type="button"
                key={language}
                lang={language}
                aria-pressed={locale === language}
                onClick={() => setLocale(language)}
              >
                {language.toUpperCase()}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
    </aside>
  );
}
