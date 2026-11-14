import classNames from "classnames";
import {
  ArrowRight,
  ChevronDown,
  Code2,
  FolderOpen,
  Library,
  Plus,
  UserRound,
} from "lucide-react";
import { useAccount } from "../Account/Account";
import styles from "./ProjectMenu.module.css";

export function ProjectMenu({
  projectName,
  open,
  onOpenChange,
  busy,
  hasExamples,
  onSwitchProject,
  onExamples,
  onExport,
  onReveal,
}: {
  projectName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  hasExamples: boolean;
  onSwitchProject: (create: boolean) => void;
  onExamples: () => void;
  onExport: () => void;
  onReveal: () => void;
}) {
  const {
    user,
    openProfile,
    openUpgrade,
    refresh: refreshAccount,
  } = useAccount();
  return (
    <div className={styles.projectPickerWrap}>
      <button
        className={styles.projectPicker}
        type="button"
        aria-label="Project and account"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          onOpenChange(!open);
          if (!open) void refreshAccount().catch(() => {});
        }}
        disabled={busy}
      >
        <span className={styles.projectAvatar}>
          <Code2 size={18} />
        </span>
        <span>
          <strong>{projectName ?? "Opening workspace…"}</strong>
          <small className={styles.accountIdentity}>
            <span title={user?.username}>
              {user?.username ?? "Not signed in"}
            </span>
            {user && user.tier !== "free" && (
              <span className={styles.tierBadge} data-tier={user.tier}>
                {user.tier.toUpperCase()}
              </span>
            )}
          </small>
        </span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className={classNames(styles.menu, styles.projectMenu)}>
          <button
            type="button"
            onClick={() => {
              onOpenChange(false);
              openProfile();
            }}
          >
            <UserRound size={15} />
            {user ? "Your profile" : "Sign in"}
          </button>
          {user && (
            <div className={styles.subscription}>
              <div>
                <strong>
                  {user.tier === "free" ? "Free" : user.tier.toUpperCase()}
                </strong>
                <span>
                  {user.assist_requests_remaining} assist requests left
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  openUpgrade();
                }}
              >
                <span>Explore plans</span> <ArrowRight size={13} />
              </button>
            </div>
          )}
          <div className={styles.menuDivider} />
          <button type="button" onClick={() => onSwitchProject(true)}>
            <Plus size={15} />
            New project
          </button>
          <button type="button" onClick={() => onSwitchProject(false)}>
            <FolderOpen size={15} />
            Open project…
          </button>
          {hasExamples && (
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onExamples();
              }}
            >
              <Library size={15} />
              New from example
            </button>
          )}
          <div className={styles.menuDivider} />
          {window.workspace.platform === "web" ? (
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onExport();
              }}
            >
              Export project…
            </button>
          ) : (
            <button type="button" onClick={onReveal}>
              <ArrowRight size={15} />
              Show project folder
            </button>
          )}
        </div>
      )}
    </div>
  );
}
