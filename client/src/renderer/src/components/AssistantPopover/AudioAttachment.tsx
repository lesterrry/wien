import { Pause, Play, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import Regions, {
  type Region,
} from "wavesurfer.js/dist/plugins/regions.esm.js";
import {
  type AudioSelection,
  assistSampleRate,
  maxAudioSeconds,
} from "../../assist-audio";
import styles from "./AssistantPopover.module.css";

export function AudioAttachment({
  file,
  pending,
  onSelect,
  onRemove,
}: {
  file: File;
  pending: boolean;
  onSelect: (selection: AudioSelection | null) => void;
  onRemove: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const wave = useRef<WaveSurfer | null>(null);
  const region = useRef<Region | null>(null);
  const [range, setRange] = useState({ start: 0, end: 0, duration: 0 });
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    setReady(false);
    setError("");
    onSelect(null);
    const regions = Regions.create();
    const colors = getComputedStyle(container.current);
    const accent = colors.getPropertyValue("--color-brand").trim();
    const ws = WaveSurfer.create({
      container: container.current,
      height: 64,
      waveColor: colors.getPropertyValue("--color-secondary").trim(),
      progressColor: accent,
      cursorColor: accent,
      sampleRate: assistSampleRate,
      minPxPerSec: 24,
      autoScroll: true,
      normalize: true,
      plugins: [regions],
    });
    wave.current = ws;
    ws.on("play", () => setPlaying(true));
    ws.on("pause", () => setPlaying(false));
    ws.on("error", () => {
      if (!disposed) setError("Could not decode this MP3. Try another file.");
    });
    const update = (r: Region) => {
      const buffer = ws.getDecodedData();
      if (!buffer || disposed) return;
      ws.pause();
      setRange({ start: r.start, end: r.end, duration: buffer.duration });
      onSelect({ buffer, start: r.start, end: r.end });
    };
    regions.on("region-updated", update);
    regions.on("region-out", () => ws.pause());
    void ws
      .loadBlob(file)
      .then(() => {
        if (disposed) return;
        const buffer = ws.getDecodedData();
        if (!buffer || buffer.duration < 0.1 || buffer.duration > 900) {
          throw new Error(
            "Use an MP3 between 0.1 seconds and 15 minutes long.",
          );
        }
        const r = regions.addRegion({
          start: 0,
          end: Math.min(maxAudioSeconds, buffer.duration),
          minLength: 0.1,
          maxLength: maxAudioSeconds,
          color: "color-mix(in srgb, var(--color-brand) 23%, transparent)",
          drag: true,
          resize: true,
        });
        region.current = r;
        update(r);
        setReady(true);
      })
      .catch((error: unknown) => {
        if (!disposed)
          setError(
            error instanceof Error && error.message.startsWith("Use an MP3")
              ? error.message
              : "Could not decode this MP3. Try another file.",
          );
      });
    return () => {
      disposed = true;
      ws.destroy();
      wave.current = null;
      region.current = null;
    };
  }, [file, onSelect]);

  useEffect(() => {
    region.current?.setOptions({ drag: !pending, resize: !pending });
    if (pending) wave.current?.pause();
  }, [pending]);

  function change(side: "start" | "end", value: number) {
    if (!Number.isFinite(value) || !region.current) return;
    let start = range.start;
    let end = range.end;
    if (side === "start") {
      start = Math.max(0, Math.min(value, range.duration - 0.1));
      end = Math.min(
        range.duration,
        start + Math.min(10, range.end - range.start),
      );
    } else {
      end = Math.max(start + 0.1, Math.min(value, range.duration, start + 10));
    }
    region.current.setOptions({ start, end });
    setRange({ ...range, start, end });
    const buffer = wave.current?.getDecodedData();
    if (buffer) onSelect({ buffer, start, end });
    wave.current?.pause();
    wave.current?.setTime(start);
  }

  return (
    <div className={styles.attachment}>
      <div className={styles.audioHeader}>
        <span title={file.name}>{file.name}</span>
        <button
          type="button"
          aria-label="Remove audio"
          disabled={pending}
          onClick={onRemove}
        >
          <X size={14} />
        </button>
      </div>
      <div ref={container} className={styles.waveform} inert={pending} />
      {error ? (
        <p role="alert">{error}</p>
      ) : !ready ? (
        <p role="status">Loading audio…</p>
      ) : (
        <div className={styles.trimControls}>
          <button
            type="button"
            aria-label={
              playing ? "Pause audio preview" : "Preview selected audio"
            }
            disabled={pending}
            onClick={() => {
              if (playing) wave.current?.pause();
              else
                void wave.current
                  ?.play(range.start, range.end)
                  .catch(() => setError("Could not play the preview."));
            }}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <label>
            From{" "}
            <input
              aria-label="Audio start seconds"
              type="number"
              min={0}
              max={Math.max(0, range.duration - 0.1)}
              step={0.01}
              value={Number(range.start.toFixed(2))}
              disabled={pending}
              onChange={(e) => change("start", e.target.valueAsNumber)}
            />
          </label>
          <label>
            To{" "}
            <input
              aria-label="Audio end seconds"
              type="number"
              min={range.start + 0.1}
              max={Math.min(range.duration, range.start + 10)}
              step={0.01}
              value={Number(range.end.toFixed(2))}
              disabled={pending}
              onChange={(e) => change("end", e.target.valueAsNumber)}
            />
          </label>
          <span>{(range.end - range.start).toFixed(2)} / 10 s</span>
        </div>
      )}
    </div>
  );
}

export function AudioPicker({
  onFile,
  onError,
}: {
  onFile: (file: File) => void;
  onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".mp3,audio/mpeg"
        className={styles.srOnly}
        aria-label="Choose MP3 file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          if (!file.name.toLowerCase().endsWith(".mp3")) {
            onError("Choose an MP3 file.");
            return;
          }
          if (!file.size || file.size > 50 * 1024 * 1024) {
            onError("Choose an MP3 up to 50 MB.");
            return;
          }
          onFile(file);
        }}
      />
      <button
        type="button"
        className={styles.chooseAudio}
        onClick={() => input.current?.click()}
      >
        <Upload size={14} /> Choose MP3
      </button>
      <p>Select up to 10 seconds. Audio requests are counted separately.</p>
    </>
  );
}
