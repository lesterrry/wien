import classNames from "classnames";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import type { ReactNode } from "react";
import { commands, shortcutLabel } from "../../../../shared/commands";
import { shortcutEnvironment } from "../../commands";
import { t, useLocale } from "../../i18n";
import { shortcut } from "../App/workspace-utils";
import { SplitMarquee } from "../SplitMarquee/SplitMarquee";
import styles from "./WorkspaceTitlebar.module.css";

export function WorkspaceTitlebar({
  playing,
  sidebar,
  onSidebar,
  controlsVisible,
  controllerOpen,
  graphActive,
  onControls,
  tabs,
}: {
  playing: boolean;
  sidebar: boolean;
  onSidebar: () => void;
  controlsVisible: boolean;
  controllerOpen: boolean;
  graphActive: boolean;
  onControls: () => void;
  tabs: ReactNode;
}) {
  useLocale();
  return (
    <div
      className={classNames(styles.titlebar, {
        [styles.web]: window.workspace.platform === "web",
      })}
    >
      <div className={styles.titlebarSidebar}>
        <span className={styles.appName}>
          <SplitMarquee
            text="wien hauptbahnhof südtiroler platz"
            paused={!playing}
          />
        </span>
        <button
          className={styles.iconButton}
          type="button"
          title={t("Toggle sidebar ({p0} B)", { p0: shortcut })}
          aria-label={t("Toggle sidebar")}
          onClick={onSidebar}
        >
          {sidebar ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
        </button>
      </div>
      <div className={styles.titlebarMain}>
        {tabs}
        <button
          type="button"
          className={styles.iconButton}
          title={t("Toggle controls ({p0})", {
            p0: shortcutLabel(
              commands.find((command) => command.id === "controls") ?? {
                id: "controls",
                label: t("Toggle Controls"),
              },
              shortcutEnvironment,
            ),
          })}
          aria-label={t("Toggle controls")}
          aria-expanded={controlsVisible && !controllerOpen && !graphActive}
          disabled={graphActive}
          onClick={onControls}
        >
          {controlsVisible ? (
            <PanelRightClose size={17} />
          ) : (
            <PanelRightOpen size={17} />
          )}
        </button>
      </div>
    </div>
  );
}
