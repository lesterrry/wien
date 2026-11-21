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
import { getLocale, t, useLocale } from "../../i18n";
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
  useLocale();
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
        aria-label={t("Project and account")}
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
          <strong>{projectName ?? t("Opening workspace…")}</strong>
          <small className={styles.accountIdentity}>
            <span title={user?.username}>
              {user?.username ?? t("Not signed in")}
            </span>
            {user && !user.plan.is_default && (
              <span className={styles.tierBadge} data-tier={user.tier}>
                {getLocale() === "ru"
                  ? user.plan.name_ru || user.plan.name
                  : user.plan.name}
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
            {user ? t("Your profile") : t("Sign in")}
          </button>
          {user && (
            <div className={styles.subscription}>
              <div>
                <strong>{user.plan.name}</strong>
                <span>
                  {user.plan.initial_assist_requests === null
                    ? t("Subscription active")
                    : user.plan.is_default
                      ? t("{p0} assist requests left", {
                          p0: user.assist_requests_remaining,
                        })
                      : t("{p0}% of assist requests left", {
                          p0:
                            user.plan.initial_assist_requests > 0
                              ? Math.min(
                                  100,
                                  Math.round(
                                    (user.assist_requests_remaining /
                                      user.plan.initial_assist_requests) *
                                      100,
                                  ),
                                )
                              : 0,
                        })}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  openUpgrade();
                }}
              >
                <span>
                  {user.plan.is_default
                    ? t("Explore plans")
                    : t("Manage billing")}
                </span>{" "}
                <ArrowRight size={13} />
              </button>
            </div>
          )}
          <div className={styles.menuDivider} />
          <button type="button" onClick={() => onSwitchProject(true)}>
            <Plus size={15} />
            {t("New project")}
          </button>
          <button type="button" onClick={() => onSwitchProject(false)}>
            <FolderOpen size={15} />
            {t("Open project…")}
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
              {t("New from example")}
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
              {t("Export project…")}
            </button>
          ) : (
            <button type="button" onClick={onReveal}>
              <ArrowRight size={15} />
              {t("Show project folder")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
