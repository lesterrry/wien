import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import { changeControl, readControls } from "../../shared/controls";
import type { ModuleGraph } from "../../shared/modules";
import { editSource, loadGraph } from "../../shared/modules";
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
  if (/^\$:/m.test(sources[entry])) {
    const repl = core.repl({
      getTime: () => 0,
      defaultOutput: () => {},
      transpiler: () => compiled,
      onEvalError: (error) => {
        throw error;
      },
    });
    try {
      return await repl.evaluate(sources[entry], false);
    } finally {
      repl.stop();
    }
  }
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

async function example(id: string): Promise<Record<string, string>> {
  const directory = `../examples/${id}`;
  const files = (await readdir(directory, { recursive: true }))
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => /\.(strudel|js)$/.test(path));
  return Object.fromEntries(
    await Promise.all(
      files.map(
        async (path) =>
          [path, await readFile(`${directory}/${path}`, "utf8")] as const,
      ),
    ),
  );
}

test("every example compiles, has valid controls, and produces bounded finite events", async () => {
  await core.evalScope({ setcpm: () => {} });
  const kinds = new Set<string>();
  for (const entry of await readdir("../examples", { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sources = await example(entry.name);
    for (const [path, code] of Object.entries(sources)) {
      const parsed = readControls(code);
      assert(parsed.valid, `${entry.name}/${path}: invalid controls`);
      assert.deepEqual(parsed.errors ?? [], [], `${entry.name}/${path}`);
      for (const control of parsed.controls) kinds.add(control.kind);
      if (!path.endsWith(".strudel")) continue;
      const graph = await loadGraph(path, async (file) => sources[file]);
      const pattern = await evaluate(graph.sources, path);
      assert.equal(
        typeof pattern?.queryArc,
        "function",
        `${entry.name}/${path}`,
      );
      const events = pattern.queryArc(0, 96);
      assert(
        events.length > 0 && events.length < 12000,
        `${entry.name}/${path}: event count ${events.length}`,
      );
      for (const event of events) {
        assert(Number.isFinite(Number(event.whole?.begin)));
        for (const [key, value] of Object.entries(event.value)) {
          if (typeof value === "number")
            assert(Number.isFinite(value), `${path}: ${key}`);
        }
      }
    }
  }
  assert.deepEqual([...kinds].sort(), [
    "boolean",
    "enum",
    "multi-enum",
    "number",
    "slider",
  ]);
});

test("Glass Nerve has a drumless contrast, a returning hook, and a complete 96-bar form", async () => {
  const sources = await example("default");
  const pattern = await evaluate(sources, "glass-nerve.strudel");
  const sounds = (start: number, end: number) =>
    pattern
      .queryArc(start, end)
      .map((event: { value: { s: string } }) => event.value.s);
  assert(sounds(8, 24).includes("sbd"));
  assert(!sounds(40, 56).includes("sbd"));
  assert(sounds(64, 80).includes("sbd"));
  const keys = (start: number) =>
    pattern
      .queryArc(start, start + 8)
      .filter((event: { value: { orbit: number } }) => event.value.orbit === 1)
      .map((event: { value: { note: string } }) => event.value.note);
  assert.deepEqual(keys(0), keys(64));
  assert.deepEqual(keys(0), keys(96));
});

test("Memory Console retains the melody and changes real serial FX order", async () => {
  const sources = await example("control-room");
  const path = "voices/memory.strudel";
  assert(
    sources[path].includes(
      "<[~ eb4 g4 ~ bb4 ~ g4 ~] [~ eb4 ~ f4 g4 [~ c5] bb4 ~]>",
    ),
  );
  const set = (name: string, value: string | number | string[]) => {
    const edit = changeControl(sources[path], name, { type: "set", value });
    assert(edit);
    sources[path] = editSource(sources[path], [edit]);
  };
  set("waveform", "sawtooth");
  set("effects", ["crush", "lowpass"]);
  const order = changeControl(sources[path], "effects", {
    type: "reorder",
    order: ["Crush", "Lowpass", "Echo", "Drive"],
  });
  assert(order);
  sources[path] = editSource(sources[path], [order]);
  const pattern = await evaluate(sources, "memory-console.strudel");
  const voices = pattern
    .queryArc(0, 2)
    .filter((event: { value: { orbit: number } }) => event.value.orbit === 1);
  assert(voices.length > 0);
  for (const { value } of voices) {
    assert.equal(value.s, "sawtooth");
    assert.equal(value.FX[0].crush, 4);
    assert.equal(value.FX[1].cutoff, 1800);
  }
  set("effects", []);
  const dry = await evaluate(sources, "memory-console.strudel");
  assert(
    dry
      .queryArc(0, 2)
      .every((event: { value: { FX?: unknown } }) => !event.value.FX),
  );
});

test("Signal Garden shares its instrument between named and namespace imports", async () => {
  const sources = await example("signal-garden");
  const path = "shared/prism.js";
  const edit = changeControl(sources[path], "waveform", {
    type: "set",
    value: "triangle",
  });
  assert(edit);
  sources[path] = editSource(sources[path], [edit]);
  const pattern = await evaluate(sources, "garden.strudel");
  for (const orbit of [1, 2]) {
    const notes = pattern
      .queryArc(0, 12)
      .filter(
        (event: { value: { orbit: number } }) => event.value.orbit === orbit,
      );
    assert(notes.length > 0);
    assert(
      notes.every(
        (event: { value: { s: string } }) => event.value.s === "triangle",
      ),
    );
  }
});
