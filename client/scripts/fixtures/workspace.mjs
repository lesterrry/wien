import fs from "node:fs/promises";
import path from "node:path";

// Synthetic tones for UI regressions. Keep these independent of the musical
// examples: changing a composition must not change a control or filesystem test.
export const workspaceFiles = {
  "controls-demo.strudel": `const Wave = Object.freeze({ Sine: 'sine', Triangle: 'triangle', Saw: 'sawtooth' })
const Fx = Object.freeze({ Echo: 'echo', Chorus: 'chorus', Crush: 'crush' })
const waveform = Wave.Triangle
const effects = [Fx.Echo, Fx.Chorus]
const enabled = true
const gain = 0.2
const repeats = 1
const cutoff = 1200 // @slider 20..20000
const pan = 0 // @slider vertical -1..1
const speed = 1 // @slider 0.25..4
const wet = 0.15 // @slider vertical 0..1
const tempo = 108 // @ignore
setcpm(tempo / 4)
const voice = note("c4*4").s(waveform).orbit(1)
  .decay(0.14).sustain(0).release(0.04)
  .fast(Math.max(1, repeats) * speed)
  .lpf(cutoff).pan(pan).room(wet)
  .gain(enabled ? Math.max(0, gain) : 0)
effects.reduce((pattern, effect) => {
  switch (effect) {
    case Fx.Echo: return pattern.delay(0.38).delaytime(0.16).delayfeedback(0.42)
    case Fx.Chorus: return pattern.chorus(0.55)
    case Fx.Crush: return pattern.crush(5)
    default: return pattern
  }
}, voice)
`,
  "first-light.strudel": `import glass from './instruments/glass.strudel'
setcpm(108 / 4)
glass
`,
  "instruments/glass.strudel":
    'export default note("c4*4").s("sine").gain(0.15)\n',
  "sketches/low-tide.strudel": 'note("c3*4").s("sine").gain(0.1)\n',
  "sketches/soft-steps.strudel": 'note("e3*4").s("triangle").gain(0.1)\n',
};

export async function writeFiles(root, files) {
  for (const [file, source] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), source);
  }
}

export async function seedWorkspace(userData) {
  await writeFiles(
    path.join(userData, "projects/First session"),
    workspaceFiles,
  );
}

export async function seedBrowserWorkspace(page) {
  await page.getByLabel("Strudel code editor", { exact: true }).waitFor();
  await page.evaluate(async (files) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("wien-projects", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("projects", "readwrite");
        const store = tx.objectStore("projects");
        store.clear();
        store.put({
          id: "ui-test-project",
          name: "First session",
          revision: 0,
          files,
          folders: ["instruments", "sketches"],
          preferences: null,
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
    localStorage.setItem("wien:active-project", "ui-test-project");
  }, workspaceFiles);
  await page.reload();
  await page.getByLabel("Strudel code editor", { exact: true }).waitFor();
}
