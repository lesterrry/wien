import { ArrowRight } from "lucide-react";
import { commands, shortcutLabel } from "../../../../shared/commands";
import { shortcutEnvironment } from "../../commands";
import { Dialog } from "../Dialog/Dialog";
import styles from "./GettingStartedDialog.module.css";

export function GettingStartedDialog({
  onClose,
  onTour,
}: {
  onClose: () => void;
  onTour: () => void;
}) {
  return (
    <Dialog title="A place to play" onClose={onClose}>
      <div className={styles.helpContent}>
        <p>
          Write Strudel code, play it, and follow the sound.{" "}
          {window.workspace.platform === "web"
            ? "Your projects are saved in this browser. Export a project to keep a backup or move it to another browser."
            : "Your snippets are plain files on your computer."}
        </p>
        {commands
          .filter((command) =>
            ["play", "stop", "stopAll", "assist"].includes(command.id),
          )
          .map((command) => (
            <div key={command.id}>
              <span>{command.label}</span>
              <kbd>{shortcutLabel(command, shortcutEnvironment)}</kbd>
            </div>
          ))}
        <p className={styles.muted}>
          Drag snippets into folders to organize them. Starter sounds use
          built-in synthesizers and work offline. Playback continues while you
          browse other snippets.
        </p>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onTour}
        >
          Take a tour
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={onClose}
        >
          Let’s make something
        </button>
      </div>
    </Dialog>
  );
}
