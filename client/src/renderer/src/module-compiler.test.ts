import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import { changeControl } from "../../shared/controls";
import type { ModuleGraph } from "../../shared/modules";
import { editSource } from "../../shared/modules";
import { compileGraph as compile } from "./module-compiler";

const transpilerModule = import("@strudel/transpiler");
async function compileGraph(graph: ModuleGraph) {
  return compile(graph, (await transpilerModule).transpiler);
}

async function evaluate(
  sources: Record<string, string>,
  entry = "main.strudel",
) {
  await core.evalScope(core, mini);
  const compiled = await compileGraph({ entry, sources });
  return Function(`return (async () => {${compiled.output}})()`)();
}

test("nested default and named imports produce actual Strudel events", async () => {
  const pattern = await evaluate({
    "main.strudel":
      "import glass from './glass.strudel'; import { voice } from './voice.strudel'; stack(glass, voice('e4'))",
    "glass.strudel":
      "import { voice } from './voice.strudel'; export default voice('c4')",
    "voice.strudel": 'export const voice = (notes) => note(notes).s("sine")',
  });
  assert.deepEqual(
    pattern.queryArc(0, 1).map((event: { value: unknown }) => event.value),
    [
      { note: "c4", s: "sine" },
      { note: "e4", s: "sine" },
    ],
  );
});

test("default exports play alone and legacy snippets still play", async () => {
  for (const source of [
    'export default note("c4")',
    'export default (note("c4"))',
    'note("c4")',
    'const p = note("c4"); export { p as default }',
  ]) {
    const pattern = await evaluate({ "main.strudel": source });
    assert.equal(pattern.queryArc(0, 1)[0].value.note, "c4");
  }
});

test("default function declarations keep their local names", async () => {
  const pattern = await evaluate({
    "main.strudel":
      "import glass, { bell } from './glass.strudel'; stack(glass(), bell())",
    "glass.strudel":
      'export default function bell() { return note("c4") }\nexport { bell }',
  });
  assert.equal(pattern.queryArc(0, 1).length, 2);
});

test("diamond dependencies execute once per update and refresh next time", async () => {
  const sources = {
    "main.strudel":
      "import a from './a.strudel'; import b from './b.strudel'; stack(a,b)",
    "a.strudel":
      "import * as shared from './shared.strudel'; export default shared.default",
    "b.strudel": "import s from './shared.strudel'; export default s",
    "shared.strudel":
      'globalThis.__wienModuleCount++; export default note("c4")',
  };
  const scope = globalThis as typeof globalThis & { __wienModuleCount: number };
  scope.__wienModuleCount = 0;
  await evaluate(sources);
  assert.equal(scope.__wienModuleCount, 1);
  sources["shared.strudel"] =
    'globalThis.__wienModuleCount++; export default note("d4")';
  const updated = await evaluate(sources);
  assert.equal(scope.__wienModuleCount, 2);
  assert.equal(updated.queryArc(0, 1)[0].value.note, "d4");
});

test("imported tempo calls and source locations do not affect the root", async () => {
  const tempos: number[] = [];
  await core.evalScope({ setcpm: (tempo: number) => tempos.push(tempo) });
  const pattern = await evaluate({
    "main.strudel": "import glass from './glass.strudel'; setcpm(27); glass",
    "glass.strudel":
      '// const setcpm is only a comment\nsetcpm(25); export default note("c4")',
  });
  assert.deepEqual(tempos, [27]);
  assert.deepEqual(pattern.queryArc(0, 1)[0].context.locations, []);
});

test("missing exports, cycles, syntax and runtime errors identify the file", async () => {
  await assert.rejects(
    () =>
      compileGraph({
        entry: "main.strudel",
        sources: {
          "main.strudel": "import bell from './glass.strudel'; bell",
          "glass.strudel": "export const voice = 1",
        },
      }),
    /main.strudel:1: glass.strudel has no default export/,
  );
  await assert.rejects(
    () =>
      compileGraph({
        entry: "main.strudel",
        sources: { "main.strudel": "note(" },
      }),
    /main.strudel:.*1:5/,
  );
  await assert.rejects(
    evaluate({
      "main.strudel": "import bell from './glass.strudel'; bell",
      "glass.strudel": "export default noSuchFunction()",
    }),
    /glass.strudel: noSuchFunction/,
  );
});

test("annotated variables are ordinary JavaScript in roots and dependencies", async () => {
  const pattern = await evaluate({
    "main.strudel": `import voice from './voice.strudel';
// ordinary numeric binding
const gain = 0.25;
if (typeof gain !== 'number' || gain !== 0.25 || !Number.isFinite(gain)) throw new Error('not a primitive');
voice.gain(gain)`,
    "voice.strudel": `//@slider vertical -1..1
const pan = 0.5;
export default note('c3').pan(pan)`,
  });
  assert.deepEqual(pattern.queryArc(0, 1)[0].value, {
    note: "c3",
    pan: 0.5,
    gain: 0.25,
  });
});

test("the playable slider example produces numeric Strudel parameters", async () => {
  const source = await readFile(
    "../examples/default/controls-demo.strudel",
    "utf8",
  );
  await core.evalScope({ setcpm: () => {} });
  const pattern = await evaluate({ "main.strudel": source });
  const events = pattern.queryArc(0, 1);
  assert(
    events.some(({ value }: { value: { s: string } }) => value.s === "sbd"),
  );
  assert(
    events.some(({ value }: { value: { s: string } }) => value.s === "white"),
  );
  const lead = events.filter(
    ({ value }: { value: { orbit: number } }) => value.orbit === 1,
  );
  assert(lead.length > 0);
  for (const { value } of lead) {
    assert.equal(value.s, "triangle");
    assert.equal(value.cutoff, 1200);
    assert.equal(value.pan, 0);
    assert.equal(value.delay, 0.38);
    assert.equal(value.chorus, 0.55);
  }
});

test("playground enum edits change the lead and combine selected effects", async () => {
  const source = await readFile(
    "../examples/default/controls-demo.strudel",
    "utf8",
  );
  const edit = changeControl(source, "waveform", {
    type: "set",
    value: "sawtooth",
  });
  assert(edit);
  const changed = editSource(source, [edit]);
  assert.match(changed, /const waveform = Wave.Saw/);
  const effectsEdit = changeControl(changed, "effects", {
    type: "set",
    value: ["echo", "crush"],
  });
  assert(effectsEdit);
  const updated = editSource(changed, [effectsEdit]);
  assert.match(updated, /const effects = \[Fx.Echo, Fx.Crush\]/);
  const pattern = await evaluate({ "main.strudel": updated });
  const lead = pattern
    .queryArc(0, 1)
    .filter((hap: { value: { orbit: number } }) => hap.value.orbit === 1);
  assert(lead.length > 0);
  for (const { value } of lead) {
    assert.equal(value.s, "sawtooth");
    assert.equal(value.delay, 0.38);
    assert.equal(value.crush, 5);
    assert.equal(value.chorus, undefined);
  }
});

test("import playground uses every voice, including deep and shared control sources", async () => {
  const paths = [
    "playground.strudel",
    "playground/rhythm.strudel",
    "playground/kick.strudel",
    "playground/hats.strudel",
    "playground/bass.strudel",
    "playground/lead.strudel",
    "playground/tone.strudel",
  ];
  const sources = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        await readFile(`../examples/controls-playground/${path}`, "utf8"),
      ]),
    ),
  );
  await core.evalScope({ setcpm: () => {} });
  const pattern = await evaluate(sources, "playground.strudel");
  const events = pattern.queryArc(0, 1);
  assert(
    events.some(({ value }: { value: { s: string } }) => value.s === "white"),
  );
  assert(
    events.some(
      ({ value }: { value: { s: string; gain: number } }) =>
        value.s === "sbd" && value.gain === 0.28,
    ),
  );
  const edit = changeControl(sources["playground/kick.strudel"], "kickGain", {
    type: "set",
    value: 0,
  });
  assert(edit);
  sources["playground/kick.strudel"] = editSource(
    sources["playground/kick.strudel"],
    [edit],
  );
  const updated = await evaluate(sources, "playground.strudel");
  assert(
    updated
      .queryArc(0, 1)
      .filter(({ value }: { value: { s: string } }) => value.s === "sbd")
      .every(({ value }: { value: { gain: number } }) => value.gain === 0),
  );
  const toneEdit = changeControl(
    sources["playground/tone.strudel"],
    "waveform",
    { type: "set", value: "sawtooth" },
  );
  assert(toneEdit);
  sources["playground/tone.strudel"] = editSource(
    sources["playground/tone.strudel"],
    [toneEdit],
  );
  const timbre = await evaluate(sources, "playground.strudel");
  const voices = timbre
    .queryArc(0, 1)
    .filter(
      ({ value }: { value: { note?: string } }) =>
        value.note && value.note !== "c1",
    );
  assert(voices.length > 0);
  assert(
    voices.every(
      ({ value }: { value: { s: string } }) => value.s === "sawtooth",
    ),
  );
  const lead = timbre
    .queryArc(0, 1)
    .filter(({ value }: { value: { FX?: unknown[] } }) => value.FX);
  assert(lead.length > 0);
  assert.deepEqual(lead[0].value.FX, [
    { crush: 3 },
    { cutoff: 900, resonance: 1.2 },
  ]);
  const reordered = changeControl(
    sources["playground/lead.strudel"],
    "effects",
    { type: "reorder", order: ["Lowpass", "Crush", "Drive", "Echo"] },
  );
  assert(reordered);
  sources["playground/lead.strudel"] = editSource(
    sources["playground/lead.strudel"],
    [reordered],
  );
  const orderedPattern = await evaluate(sources, "playground.strudel");
  assert.deepEqual(
    orderedPattern
      .queryArc(0, 1)
      .find(({ value }: { value: { FX?: unknown[] } }) => value.FX).value.FX,
    [{ cutoff: 900, resonance: 1.2 }, { crush: 3 }],
  );
  const all = changeControl(sources["playground/lead.strudel"], "effects", {
    type: "set",
    value: ["lowpass", "crush", "drive", "echo"],
  });
  assert(all);
  sources["playground/lead.strudel"] = editSource(
    sources["playground/lead.strudel"],
    [all],
  );
  const allPattern = await evaluate(sources, "playground.strudel");
  assert.deepEqual(
    allPattern
      .queryArc(0, 1)
      .find(({ value }: { value: { FX?: unknown[] } }) => value.FX).value.FX,
    [
      { cutoff: 900, resonance: 1.2 },
      { crush: 3 },
      { distort: 2, distortvol: 0.5 },
      { delay: 0.45, delaytime: 0.16, delayfeedback: 0.35 },
    ],
  );
  const dryEdit = changeControl(sources["playground/lead.strudel"], "effects", {
    type: "set",
    value: [],
  });
  assert(dryEdit);
  sources["playground/lead.strudel"] = editSource(
    sources["playground/lead.strudel"],
    [dryEdit],
  );
  const dry = await evaluate(sources, "playground.strudel");
  assert(
    dry
      .queryArc(0, 1)
      .some(({ value }: { value: { note?: string } }) => value.note === "c4"),
  );
  assert(
    dry
      .queryArc(0, 1)
      .every(({ value }: { value: { FX?: unknown[] } }) => !value.FX),
  );
  const bank = changeControl(sources["playground/rhythm.strudel"], "drumBank", {
    type: "set",
    value: "tr909",
  });
  assert(bank);
  sources["playground/rhythm.strudel"] = editSource(
    sources["playground/rhythm.strudel"],
    [bank],
  );
  const sampled = await evaluate(sources, "playground.strudel");
  const drums = sampled
    .queryArc(0, 1)
    .filter(({ value }: { value: { bank?: string } }) => value.bank);
  assert(drums.length > 0);
  assert(
    drums.every(
      ({ value }: { value: { bank: string; s: string } }) =>
        value.bank === "tr909" && ["bd", "hh"].includes(value.s),
    ),
  );
});
