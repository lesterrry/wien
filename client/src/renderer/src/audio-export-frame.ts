import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import * as tonal from "@strudel/tonal";
import { transpiler } from "@strudel/transpiler";
import * as audio from "@strudel/webaudio";
import {
  type AudioExportOptions,
  encodeWav,
  exportDuration,
  exportSampleRate,
} from "../../shared/audio-export";
import type { ModuleGraph } from "../../shared/modules";
import { compileGraph } from "./module-compiler";
import { registerStandardSounds } from "./standard-sounds";

interface Hap {
  hasOnset(): boolean;
  ensureObjectValue(): void;
  whole: { begin: number };
  duration: number;
  value: Record<string, unknown>;
}
interface AudioPattern {
  queryArc(start: number, end: number, controls: { _cps: number }): Hap[];
}

async function render(
  graph: ModuleGraph,
  options: AudioExportOptions,
  port: MessagePort,
) {
  const progress = (phase: string, fraction: number) =>
    port.postMessage({ type: "progress", progress: { phase, fraction } });
  progress("Preparing sounds…", 0);
  await core.evalScope(core, mini, tonal, audio);
  await registerStandardSounds();
  const compiled = compileGraph(graph, transpiler);
  const repl = core.repl({
    getTime: () => 0,
    defaultOutput: () => {},
    transpiler: () => compiled,
    onEvalError: (error) => {
      throw error;
    },
  });
  let pattern: AudioPattern;
  let cps: number;
  try {
    pattern = (await repl.evaluate(graph.entry, false)) as AudioPattern;
    cps = repl.scheduler.cps;
  } finally {
    repl.stop();
  }
  if (!pattern?.queryArc)
    throw new Error("End the snippet with a playable pattern.");
  const duration = exportDuration(options, cps);
  await audio.getAudioContext().close();
  const context = new OfflineAudioContext(
    2,
    Math.ceil(duration * exportSampleRate),
    exportSampleRate,
  );
  audio.setAudioContext(context);
  // All synthesis and effect sends must use the same controller module.
  // Strudel 1.3 renderPatternAudio imports a separate controller via a subpath.
  audio.setSuperdoughAudioController(null);
  await audio.initAudio({ maxPolyphony: 128, multiChannelOrbits: false });
  const haps = pattern
    .queryArc(0, options.cycles, { _cps: cps })
    .filter((hap) => hap.hasOnset())
    .sort((a, b) => Number(a.whole.begin) - Number(b.whole.begin));
  for (let i = 0; i < haps.length; i++) {
    const hap = haps[i];
    hap.ensureObjectValue();
    if (hap.value.cps !== undefined && Number(hap.value.cps) !== cps)
      throw new Error(
        "WAV export currently requires a constant tempo. Use setcps or setcpm.",
      );
    const begin = Number(hap.whole.begin) / cps;
    await audio.superdough(
      hap.value,
      begin,
      Number(hap.duration) / cps,
      cps,
      begin,
    );
    if (i % 32 === 0) {
      progress("Loading and arranging sounds…", (0.2 * (i + 1)) / haps.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  progress("Rendering audio…", 0.2);
  const timer = setInterval(
    () =>
      progress(
        "Rendering audio…",
        0.2 + (0.75 * context.currentTime) / duration,
      ),
    150,
  );
  try {
    const buffer = await context.startRendering();
    progress("Encoding WAV…", 0.96);
    const wav = encodeWav(
      [buffer.getChannelData(0), buffer.getChannelData(1)],
      options.normalize,
    );
    port.postMessage({ type: "result", wav }, [wav]);
  } finally {
    clearInterval(timer);
  }
}

window.addEventListener("message", function start(event: MessageEvent) {
  if (event.source !== parent || !event.ports[0]) return;
  window.removeEventListener("message", start);
  const port = event.ports[0];
  void render(event.data.graph, event.data.options, port).catch((error) => {
    port.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  });
});
parent.postMessage("wien:audio-ready", "*");
