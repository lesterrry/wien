import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import { build } from "esbuild";
import { workspaceWindow } from "./fixtures/onboarding.mjs";

// Real renderer, bundled synths, actual offline audio; no sample network needed.
// Previews are local artifacts, not additional assets in the example registry.
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "wien-example-audio-"),
);
const previews = path.resolve("../.local/example-previews");
await fs.mkdir(previews, { recursive: true });
const projects = [
  ["default", "glass-nerve", 96],
  ["control-room", "memory-console", 8],
  ["signal-garden", "garden", 12],
  ["drum-machines", "machine-room", 8],
  ["live-sketchbook", "session", 8],
];
const reports = [];
const compilerBundle = await build({
  stdin: {
    contents: `import { compileGraph } from './src/renderer/src/module-compiler';
import { transpiler } from '@strudel/transpiler';
export const compile = graph => compileGraph(graph, transpiler);`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  mainFields: ["module", "main"],
  format: "cjs",
  write: false,
});
const compiler = { exports: {} };
Function(
  "module",
  "exports",
  "require",
  compilerBundle.outputFiles[0].text,
)(compiler, compiler.exports, createRequire(import.meta.url));
try {
  for (const [id, entry, length] of projects) {
    if (process.env.WIEN_EXAMPLE && process.env.WIEN_EXAMPLE !== id) continue;
    const bars = Number(process.env.WIEN_RENDER_BARS) || length;
    const root = path.join(temporary, id);
    await fs.cp(path.resolve("../examples", id), root, { recursive: true });
    const env = {
      ...process.env,
      WIEN_PROJECT: root,
      WIEN_USER_DATA: path.join(root, ".state"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({
      args: ["--mute-audio", "out/main/index.js"],
      env,
    });
    try {
      const page = await workspaceWindow(app);
      page.setDefaultTimeout(30000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (event) => {
        if (event.type() === "error") console.log(event.text());
        if (
          /\[webaudio\]|AudioWorklets loaded|\[superdough\] ready/.test(
            event.text(),
          )
        )
          console.log(`${id}: ${event.text()}`);
        if (/error:|not found|could not load|cannot read/i.test(event.text()))
          errors.push(event.text());
      });
      await page.route(/^https?:\/\//, (route) => route.abort());
      await page.getByLabel("Strudel code editor", { exact: true }).waitFor();
      await page.getByRole("button", { name: /^Play/ }).click();
      await expect(
        page.getByRole("tab", { name: `${entry}.strudel`, exact: true }),
      ).toHaveAttribute("aria-description", "Playing");
      const livePeak = await page.evaluate(async () => {
        const meter = window.getAudioContext().createAnalyser();
        window
          .getSuperdoughAudioController()
          .output.destinationGain.connect(meter);
        const data = new Float32Array(meter.fftSize);
        let peak = 0;
        for (let index = 0; index < 50; index++) {
          meter.getFloatTimeDomainData(data);
          for (const value of data) peak = Math.max(peak, Math.abs(value));
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        meter.disconnect();
        window.__examplePattern = window.getPattern();
        return peak;
      });
      assert(livePeak > 0.0001, `${id}: silent live output`);
      await page
        .getByRole("button", { name: "Stop playback", exact: true })
        .click();
      // Strudel's pooled audio nodes belong to their original context. A fresh
      // document keeps the offline render independent of the live-output check.
      await page.reload();
      await page.getByLabel("Strudel code editor", { exact: true }).waitFor();
      await page.waitForFunction(
        () => typeof window.renderPatternAudio === "function",
      );
      const graph = await page.evaluate(
        async (entry) =>
          window.workspace.graph(
            `${entry}.strudel`,
            await window.workspace.read(`${entry}.strudel`),
          ),
        entry,
      );
      const compiled = compiler.exports.compile(graph);
      const cps = await page.evaluate(
        async ({ output, entry }) => {
          const repl = window.repl({
            getTime: () => 0,
            defaultOutput: () => {},
            transpiler: () => ({ output }),
            onEvalError: (error) => {
              throw error;
            },
          });
          window.__examplePattern = await repl.evaluate(entry, false);
          repl.stop();
          return repl.scheduler.cps;
        },
        { output: compiled.output, entry },
      );
      console.log(
        `${id}: live peak ${livePeak.toFixed(4)}; rendering ${bars} bars`,
      );
      const encoded = await page.evaluate(
        async ({ cps, bars }) => {
          await window.getAudioContext().close();
          const context = new OfflineAudioContext(
            2,
            Math.ceil((bars / cps) * 44100),
            44100,
          );
          window.setAudioContext(context);
          // Use one module instance for synthesis AND sends. Strudel 1.3's
          // renderPatternAudio imports a second controller through a subpath,
          // whose effect sends otherwise create nodes in a different context.
          window.setSuperdoughAudioController(null);
          await window.initAudio({
            maxPolyphony: 128,
            multiChannelOrbits: false,
          });
          const haps = window.__examplePattern
            .queryArc(0, bars, { _cps: cps })
            .filter((hap) => hap.hasOnset())
            .sort((a, b) => Number(a.whole.begin) - Number(b.whole.begin));
          for (const hap of haps) {
            hap.ensureObjectValue();
            const begin = Number(hap.whole.begin) / cps;
            await window.superdough(
              hap.value,
              begin,
              hap.duration / cps,
              cps,
              begin,
            );
          }
          const audio = await context.startRendering();
          const left = audio.getChannelData(0),
            right = audio.getChannelData(1);
          const pcm = new Int16Array(audio.length * 2);
          for (let frame = 0; frame < audio.length; frame++) {
            for (const [channel, value] of [
              left[frame],
              right[frame],
            ].entries()) {
              if (!Number.isFinite(value) || Math.abs(value) >= 1)
                throw new Error(
                  `Invalid or clipping sample at frame ${frame}: ${value}`,
                );
              pcm[frame * 2 + channel] = Math.round(value * 32767);
            }
          }
          const bytes = new Uint8Array(pcm.buffer),
            chunks = [];
          for (let offset = 0; offset < bytes.length; offset += 32768)
            chunks.push(
              String.fromCharCode(...bytes.subarray(offset, offset + 32768)),
            );
          return btoa(chunks.join(""));
        },
        { cps, bars },
      );
      const file = path.join(
        previews,
        `${entry}${bars === length ? "" : `-${bars}-bars`}.wav`,
      );
      const pcm = Buffer.from(encoded, "base64");
      const header = Buffer.alloc(44);
      header.write("RIFF", 0);
      header.writeUInt32LE(36 + pcm.length, 4);
      header.write("WAVEfmt ", 8);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(2, 22);
      header.writeUInt32LE(44100, 24);
      header.writeUInt32LE(44100 * 4, 28);
      header.writeUInt16LE(4, 32);
      header.writeUInt16LE(16, 34);
      header.write("data", 36);
      header.writeUInt32LE(pcm.length, 40);
      await fs.writeFile(file, Buffer.concat([header, pcm]));
      assert.deepEqual(errors, [], `${id}: audio errors`);
      const wav = await fs.readFile(file);
      assert.equal(wav.toString("ascii", 0, 4), "RIFF");
      const samples = new Int16Array(
        wav.buffer,
        wav.byteOffset + 44,
        (wav.length - 44) / 2,
      );
      let peak = 0,
        energy = 0,
        clipped = 0;
      for (const sample of samples) {
        peak = Math.max(peak, Math.abs(sample) / 32768);
        energy += (sample / 32768) ** 2;
        if (Math.abs(sample) >= 32767) clipped++;
      }
      assert(peak > 0.001, `${id}: silent render`);
      assert.equal(clipped, 0, `${id}: clipped samples`);
      const rms = Math.sqrt(energy / samples.length);
      const report = {
        id,
        file,
        seconds: samples.length / 2 / 44100,
        livePeak,
        peak,
        rms,
        clipped,
      };
      reports.push(report);
      console.log(JSON.stringify(report));
    } finally {
      await app.close();
    }
  }
  await fs.writeFile(
    path.join(previews, "report.json"),
    `${JSON.stringify(reports, null, 2)}\n`,
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
