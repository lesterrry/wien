import type { ReplState } from "@strudel/codemirror";
import classNames from "classnames";
import { Loader2, MoreHorizontal, Play, Square, SquareX } from "lucide-react";
import type { MouseEventHandler } from "react";
import { shortcut } from "../App/workspace-utils";
import styles from "./PlaybackControls.module.css";

export function PlaybackControls({
  path,
  busy,
  playback,
  onStop,
  onPlay,
  onActions,
  onStopAll,
}: {
  path: string | null;
  busy: boolean;
  playback: ReplState;
  onStop: () => void;
  onPlay: () => void;
  onActions: MouseEventHandler<HTMLButtonElement>;
  onStopAll?: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className={classNames(styles.iconButton, styles.stopButton)}
        title={`Stop (${shortcut} .)`}
        aria-label="Stop playback"
        disabled={!playback.started}
        onClick={onStop}
      >
        <Square size={14} fill="currentColor" />
      </button>
      {onStopAll && (
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Stop all playback"
          title={`Stop all (${shortcut} ⇧ .)`}
          onClick={onStopAll}
        >
          <SquareX size={16} />
        </button>
      )}
      <button
        type="button"
        className={styles.playButton}
        disabled={!path || playback.pending || busy}
        title={path ? `Play / update ${path}` : "Open a file to play"}
        onClick={onPlay}
      >
        {playback.pending ? (
          <Loader2 size={14} className={styles.spin} />
        ) : (
          <Play size={13} fill="currentColor" />
        )}
        <span>{playback.started ? "Update" : "Play"}</span>
        <kbd>{shortcut} ↵</kbd>
      </button>
      <button
        type="button"
        className={styles.iconButton}
        title="Snippet actions"
        aria-label="Snippet actions"
        disabled={!path || busy}
        onClick={onActions}
      >
        <MoreHorizontal size={18} />
      </button>
    </>
  );
}
