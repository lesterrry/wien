import { ArrowDownToLine, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type AudioExportProgress,
  wavFilename,
} from "../../../../shared/audio-export";
import type { ModuleGraph } from "../../../../shared/modules";
import { renderAudio } from "../../audio-export";
import { Dialog } from "../Dialog/Dialog";
import styles from "./AudioExportDialog.module.css";

export function AudioExportDialog({
  path,
  snapshot,
  onClose,
}: {
  path: string;
  snapshot: () => Promise<ModuleGraph>;
  onClose: () => void;
}) {
  const [cycles, setCycles] = useState(32);
  const [tail, setTail] = useState(2);
  const [normalize, setNormalize] = useState(false);
  const [progress, setProgress] = useState<AudioExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<ArrayBuffer | null>(null);
  const [saving, setSaving] = useState(false);
  const job = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      job.current?.abort();
    },
    [],
  );
  const cancel = () => {
    job.current?.abort();
    job.current = null;
    setProgress(null);
  };
  const save = async (data: ArrayBuffer) => {
    setSaving(true);
    try {
      if (await window.workspace.saveAudio(wavFilename(path), data)) onClose();
    } finally {
      setSaving(false);
    }
  };
  const submit = async () => {
    if (progress || saving) return;
    setError(null);
    if (ready) {
      try {
        await save(ready);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const controller = new AbortController();
    job.current = controller;
    setProgress({ phase: "Reading project…", fraction: 0 });
    try {
      const graph = await snapshot();
      const data = await renderAudio(
        graph,
        { cycles, tail, normalize },
        controller.signal,
        setProgress,
      );
      if (controller.signal.aborted) return;
      setReady(data);
      setProgress(null);
      await save(data);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (job.current === controller) {
        job.current = null;
        setProgress(null);
      }
    }
  };
  return (
    <Dialog
      title="Save WAV"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className={styles.description}>
          Export <strong>{path}</strong> from the beginning, including its
          imports and current edits.
        </p>
        <fieldset
          disabled={Boolean(progress) || saving}
          onChange={() => setReady(null)}
        >
          <div className={styles.row}>
            <label>
              Length in cycles
              <input
                aria-label="Length in cycles"
                type="number"
                min="1"
                max="512"
                required
                value={Number.isNaN(cycles) ? "" : cycles}
                onChange={(event) => setCycles(event.target.valueAsNumber)}
              />
            </label>
            <label>
              Effect tail, seconds
              <input
                aria-label="Effect tail, seconds"
                type="number"
                min="0"
                max="30"
                step="0.5"
                required
                value={Number.isNaN(tail) ? "" : tail}
                onChange={(event) => setTail(event.target.valueAsNumber)}
              />
            </label>
          </div>
          <p className={styles.hint}>
            One cycle is usually one bar. The snippet sets the tempo.
          </p>
          <div className={styles.presets}>
            {[8, 16, 32, 64, 96].map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={cycles === value}
                onClick={() => {
                  setCycles(value);
                  setReady(null);
                }}
              >
                {value}
              </button>
            ))}
          </div>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={normalize}
              onChange={(event) => setNormalize(event.target.checked)}
            />
            Normalize peak to −1 dB
          </label>
        </fieldset>
        <p className={styles.hint}>
          Stereo · 44.1 kHz · 16-bit WAV. Overloads are reduced to prevent
          clipping.
        </p>
        {progress && (
          <div role="status" className={styles.progress}>
            <span>
              {progress.phase} {Math.round(progress.fraction * 100)}%
            </span>
            <progress
              max="1"
              value={progress.fraction}
              aria-label="Export progress"
            />
          </div>
        )}
        {ready && !progress && <p role="status">Your WAV is ready to save.</p>}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={saving}
            onClick={progress ? cancel : onClose}
          >
            {progress ? "Cancel export" : "Cancel"}
          </button>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={Boolean(progress) || saving}
          >
            {progress || saving ? (
              <Loader2 size={15} className={styles.spin} />
            ) : (
              <ArrowDownToLine size={15} />
            )}
            {saving ? "Saving…" : "Save WAV"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
