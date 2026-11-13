import type {
  AudioExportOptions,
  AudioExportProgress,
} from "../../shared/audio-export";
import type { ModuleGraph } from "../../shared/modules";

// Each export owns a document: Strudel's global controller and pooled nodes
// must never be shared between the live AudioContext and an offline context.
export function renderAudio(
  graph: ModuleGraph,
  options: AudioExportOptions,
  signal: AbortSignal,
  progress: (value: AudioExportProgress) => void,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.title = "Audio export renderer";
    frame.src = new URL("audio-export.html", window.location.href).href;
    const channel = new MessageChannel();
    const cleanup = () => {
      clearTimeout(timeout);
      window.removeEventListener("message", ready);
      signal.removeEventListener("abort", abort);
      channel.port1.close();
      channel.port2.close();
      frame.remove();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const abort = () =>
      fail(new DOMException("Export cancelled.", "AbortError"));
    const timeout = setTimeout(
      () => fail(new Error("Could not start the audio renderer.")),
      30000,
    );
    const ready = (event: MessageEvent) => {
      if (
        event.source !== frame.contentWindow ||
        event.data !== "wien:audio-ready"
      )
        return;
      clearTimeout(timeout);
      window.removeEventListener("message", ready);
      frame.contentWindow?.postMessage({ graph, options }, "*", [
        channel.port2,
      ]);
    };
    channel.port1.onmessage = ({ data }) => {
      if (data.type === "progress") progress(data.progress);
      else if (data.type === "result") {
        cleanup();
        resolve(data.wav);
      } else if (data.type === "error") fail(new Error(data.message));
    };
    window.addEventListener("message", ready);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else document.body.append(frame);
  });
}
