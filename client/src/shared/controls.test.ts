import assert from "node:assert/strict";
import { test } from "node:test";
import {
  customizationsFor,
  hasControlCustomizations,
  initialCustomization,
  sliderFields,
} from "./control-customizations";
import { canResetControl } from "./control-defaults";
import {
  changeControl,
  configureControl,
  ignoreControl,
  moveControl,
  readControlCustomization,
  readControls,
} from "./controls";
import {
  clampKnobValue,
  knobAngle,
  knobIncrement,
  normalizeKnobValue,
} from "./knob";
import { editSource } from "./modules";
import { clampSliderValue, validateSliderRange } from "./slider";

test("recognizes finite top-level numbers, arithmetic and exported bindings without executing code", () => {
  const code = `
var speed = 2;
let offset = -3.5;
export const tempo = (108 / 4), power = 2 ** 3, yes = true;
const label = "var fake = 42", infinite = 1 / 0;
const call = (() => { throw new Error('must not execute') })();
function voice() { var local = 12; }
{ let scoped = 30; }
// const commented = 40
const object = { value: 2 };
`;
  assert.deepEqual(
    readControls(code).controls.map(({ name, value }) => [name, value]),
    [
      ["speed", 2],
      ["offset", -3.5],
      ["tempo", 27],
      ["power", 8],
      ["yes", true],
    ],
  );
});

test("numeric edits preserve surrounding code, accept negative and large values, and reject non-finite values", () => {
  const code = "const gain = ((-0.25)); // voice\nnote('c3').gain(gain)";
  const edit = changeControl(code, "gain", { type: "set", value: -123456.75 });
  assert(edit);
  const changed = editSource(code, [edit]);
  assert.equal(
    changed,
    "const gain = -123456.75; // voice\nnote('c3').gain(gain)",
  );
  assert.equal(readControls(changed).controls[0].value, -123456.75);
  assert.equal(
    changeControl(code, "gain", { type: "set", value: Infinity }),
    undefined,
  );
  assert.equal(
    changeControl(code, "gain", { type: "set", value: NaN }),
    undefined,
  );
  assert.equal(
    changeControl(code, "gain", { type: "set", value: -0.25 }),
    undefined,
  );
});

test("ignore adds a reversible comment above the declaration and preserves CRLF", () => {
  const code =
    "// voice\r\n  export const gain = 0.3;\r\nnote('c3').gain(gain)";
  const edit = ignoreControl(code, "gain");
  assert(edit);
  const hidden = editSource(code, [edit]);
  assert.match(hidden, / {2}\/\/ @ignore\r\n {2}export const gain/);
  assert.deepEqual(readControls(hidden), { controls: [], valid: true });
  assert.equal(ignoreControl(hidden, "gain"), undefined);
  assert.equal(hidden.replace("  // @ignore\r\n", ""), code);
});

test("ignoring one comma binding leaves its neighbors available and code valid", () => {
  for (const name of ["a", "b", "c"]) {
    const code =
      "export const a = 1, b = 2, c = 3;\nnote('c3').gain(a + b + c)";
    const edit = ignoreControl(code, name);
    assert(edit);
    const result = readControls(editSource(code, [edit]));
    assert.equal(result.valid, true);
    assert.deepEqual(
      result.controls.map((control) => control.name),
      ["a", "b", "c"].filter((item) => item !== name),
    );
  }
});

test("ignore only applies to the next declaration, never strings or block comments", () => {
  const code = `//@ignore
const hidden = 2;
const visible = 3;
const comment = "//@ignore";
/* @ignore */
const other = 4;
`;
  assert.deepEqual(
    readControls(code).controls.map((control) => control.name),
    ["visible", "other"],
  );
});

test("incomplete code and ambiguous var redeclarations cannot leave stale controls", () => {
  assert.deepEqual(readControls("const gain = 0.3; note("), {
    controls: [],
    valid: false,
  });
  assert.deepEqual(readControls("var gain = 1; var gain = 2;").controls, []);
  assert.equal(
    changeControl("const renamed = 2", "gain", { type: "set", value: 3 }),
    undefined,
  );
  assert.equal(ignoreControl("const gain =", "gain"), undefined);
});

test("annotations choose slider presentation and edits preserve metadata", () => {
  const code = `//@slider 100..8000
const cutoff = (600 * 2); // brightness
//@slider vertical -1..1
export const pan = 0;
//@slider 0..1
const gain = 0.2;
const plain = 3;
`;
  const { controls, errors } = readControls(code);
  assert.equal(errors, undefined);
  assert.deepEqual(
    controls
      .slice(0, 3)
      .map(
        (c) =>
          c.kind === "slider" && [
            c.name,
            c.presentation,
            c.min,
            c.max,
            c.value,
          ],
      ),
    [
      ["cutoff", "horizontal", 100, 8000, 1200],
      ["pan", "vertical", -1, 1, 0],
      ["gain", "horizontal", 0, 1, 0.2],
    ],
  );
  assert.equal(controls[3].kind, "number");
  const edit = changeControl(code, "cutoff", { type: "set", value: 2500 });
  assert(edit);
  assert.equal(editSource(code, [edit]), code.replace("(600 * 2)", "2500"));
  assert.equal(
    changeControl(code, "cutoff", { type: "set", value: 8001 }),
    undefined,
  );
  assert.equal(
    changeControl(code, "cutoff", { type: "set", value: true }),
    undefined,
  );
  const ignored = ignoreControl(code, "pan");
  assert(ignored);
  assert.deepEqual(
    readControls(editSource(code, [ignored])).controls.map((c) => c.name),
    ["cutoff", "gain", "plain"],
  );
});

test("slider defaults to 0..1 and rejects unsupported tokens", () => {
  for (const annotation of [
    "@slider",
    "@slider horizontal",
    "@slider vertical",
    "@slider default",
  ]) {
    const result = readControls(`//${annotation}\nconst amount = 0.5;`);
    assert.equal(result.errors, undefined);
    const control = result.controls[0];
    assert.equal(control.kind, "slider");
    if (control.kind === "slider")
      assert.deepEqual([control.min, control.max], [0, 1]);
  }
  for (const token of ["fire", "warm-glow", "style=fire", "random-option"]) {
    const result = readControls(
      `// @slider ${token}\nconst amount = 0.5;\nconst valid = true;`,
    );
    assert.match(result.errors?.[0] ?? "", /Unknown slider setting/);
    assert.deepEqual(
      result.controls.map((control) => control.name),
      ["valid"],
    );
  }
});

test("annotation groups honor ignore in any order, comma bindings, CRLF and scope", () => {
  for (const lines of ["//@ignore\n//@slider", "//@slider\n//@ignore"]) {
    assert.deepEqual(
      readControls(`${lines}\nconst hidden = 0.5;`).controls,
      [],
    );
  }
  const code = "export const a = 1,\r\n//@slider vertical\r\nb = 0.5, c = 2;";
  const ignored = ignoreControl(code, "b");
  assert(ignored);
  assert.deepEqual(
    readControls(editSource(code, [ignored])).controls.map((c) => c.name),
    ["a", "c"],
  );
  const source = `const text = "//@slider";
/* @slider */
const plain = 2;
//@slider
const slider = 0.5;
const next = 3;
function nested() {
  //@slider
  const local = 0.5;
}`;
  assert.deepEqual(
    readControls(source).controls.map((c) => [c.name, c.kind]),
    [
      ["plain", "number"],
      ["slider", "slider"],
      ["next", "number"],
    ],
  );
});

test("invalid annotations are diagnosed without executing expressions", () => {
  for (const annotation of [
    "@slider 0..0",
    "@slider 1..-1",
    "@slider 0..Infinity",
    "@slider(0, 1)",
    "@slider()",
    "@slider(fire)",
    "@slider 0..getMax()",
  ]) {
    const result = readControls(
      `//${annotation}\nconst bad = 0.5; const ok = true;`,
    );
    assert.equal(result.valid, true);
    assert.equal(result.errors?.length, 1);
    assert.deepEqual(
      result.controls.map((c) => c.name),
      ["ok"],
    );
  }
  for (const value of [
    "2",
    "true",
    "1 / 0",
    "(() => { throw new Error('never execute') })()",
  ]) {
    assert.equal(
      readControls(`//@slider\nconst bad = ${value}`).errors?.length,
      1,
    );
  }
  assert.deepEqual(readControls("//@slider\nconst amount ="), {
    controls: [],
    valid: false,
  });
});

test("slider clamping supports fractional, tiny and negative ranges", () => {
  validateSliderRange(-1, 1, 0);
  for (const args of [
    [0, 1, NaN],
    [0, Infinity, 0],
    [1, 0, 0],
    [0, 1, 2],
  ])
    assert.throws(() =>
      validateSliderRange(...(args as [number, number, number])),
    );
  assert.equal(clampSliderValue(-1, 1, 10), 1);
  assert.equal(clampSliderValue(-1, 1, -10), -1);
  assert.equal(clampSliderValue(0, 1, 0.1 + 0.2), 0.3);
  assert.equal(clampSliderValue(20, 20000, 1221.978), 1221.978);
  assert.equal(clampSliderValue(0, 1e-8, 5e-9), 5e-9);
  assert.equal(clampSliderValue(1e12, 1e12 + 1, 1e12 + 0.5), 1e12 + 0.5);
});

test("inline sliders accept every argument order without leaking to the next binding", () => {
  for (const args of ["100..8000 vertical", "vertical 100..8000"]) {
    for (const code of [
      `const cutoff = 1200; // @slider ${args}\nconst next = 3`,
      `// @slider ${args}\nconst cutoff = 1200;\nconst next = 3`,
    ]) {
      const result = readControls(code);
      assert.equal(result.errors, undefined);
      const control = result.controls[0];
      assert.equal(control.kind, "slider");
      if (control.kind === "slider")
        assert.deepEqual(
          [control.min, control.max, control.presentation],
          [100, 8000, "vertical"],
        );
      assert.equal(result.controls[1].kind, "number");
      const edit = changeControl(code, "cutoff", { type: "set", value: 2000 });
      assert(edit);
      assert.equal(editSource(code, [edit]), code.replace("1200", "2000"));
      const hide = ignoreControl(code, "cutoff");
      assert(hide);
      assert.deepEqual(
        readControls(editSource(code, [hide])).controls.map((c) => c.name),
        ["next"],
      );
    }
  }
  const code =
    "const a = 0.5, // @slider\nb = 3;\r\nconst c = 0.2; // @slider\r\nconst d = 4";
  assert.deepEqual(
    readControls(code).controls.map((c) => [c.name, c.kind]),
    [
      ["a", "slider"],
      ["b", "number"],
      ["c", "slider"],
      ["d", "number"],
    ],
  );
});

test("all names use the same default range, and explicit ranges override it", () => {
  for (const name of ["gain", "volume", "mix", "pan", "cutoff", "unknown"]) {
    const min = 0;
    const max = 1;
    const code = `const ${name} = ${min}; // @slider`;
    const control = readControls(code).controls[0];
    assert.equal(control.kind, "slider");
    if (control.kind === "slider")
      assert.deepEqual([control.min, control.max], [min, max]);
    const edit = changeControl(code, name, { type: "set", value: max });
    assert(edit);
    const next = readControls(editSource(code, [edit])).controls[0];
    if (next.kind === "slider")
      assert.deepEqual([next.min, next.max], [min, max]);
  }
  const result = readControls("const cutoff = 0; // @slider default -1..1");
  assert.equal(result.errors, undefined);
  assert.deepEqual(
    result.controls.map(
      (c) => c.kind === "slider" && [c.min, c.max, c.presentation],
    ),
    [[-1, 1, "horizontal"]],
  );
  for (const settings of [
    "fire ice",
    "vertical horizontal",
    "default vertical",
    "0..1 -1..1",
    "0..",
    "1..0",
    "1e999..2e999",
  ]) {
    assert.equal(
      readControls(`const value = 0.5; // @slider ${settings}`).errors?.length,
      1,
    );
  }
  assert.equal(
    readControls("const amount = 0.5; // @slider .1..1e0").errors,
    undefined,
  );
});

const waveCode =
  'const Wave = Object.freeze({ Sine: "sine", Triangle: "triangle", Saw: "sawtooth" });';

test("enum selection is inferred from frozen objects and preserves symbolic references", () => {
  const code = `${waveCode}\nexport const waveform = Wave.Sine; // voice\nnote('c3').s(waveform)`;
  const control = readControls(code).controls[0];
  assert.equal(control.kind, "enum");
  if (control.kind !== "enum") return;
  assert.equal(control.value, "sine");
  assert.deepEqual(control.options, [
    { key: "Sine", value: "sine" },
    { key: "Triangle", value: "triangle" },
    { key: "Saw", value: "sawtooth" },
  ]);
  const edit = changeControl(code, "waveform", {
    type: "set",
    value: "sawtooth",
  });
  assert(edit);
  assert.equal(editSource(code, [edit]), code.replace("Wave.Sine", "Wave.Saw"));
  assert.equal(
    readControls(editSource(code, [edit])).controls[0].value,
    "sawtooth",
  );
  assert.equal(
    changeControl(code, "waveform", { type: "set", value: "missing" }),
    undefined,
  );
  assert.equal(
    changeControl(code, "waveform", { type: "set", value: true }),
    undefined,
  );
  assert.equal(
    changeControl(code, "waveform", { type: "set", value: "sine" }),
    undefined,
  );
  const hide = ignoreControl(code, "waveform");
  assert(hide);
  assert.equal(readControls(editSource(code, [hide])).controls.length, 0);
  assert.equal(
    readControls(`${waveCode}\nconst hidden = Wave.Sine; // @ignore`).controls
      .length,
    0,
  );
});

test("enum numeric values and quoted labels remain valid JavaScript after selection", () => {
  const code =
    'const Speed = Object.freeze({ Normal: 1, "Half speed": 0.5 }); const speed = Speed.Normal;';
  const edit = changeControl(code, "speed", { type: "set", value: 0.5 });
  assert(edit);
  const changed = editSource(code, [edit]);
  assert.match(changed, /speed = Speed\["Half speed"\]/);
  assert.equal(readControls(changed).controls[0].value, 0.5);
});

test("enum discovery rejects arbitrary objects, ambiguous options and shadowed globals without execution", () => {
  for (const object of [
    '{ Sine: "sine", Saw: "sawtooth" }',
    'Object.freeze({ Sine: "sine", Saw: 1 })',
    'Object.freeze({ Sine: "sine", Saw: "sine" })',
    'Object.freeze({ Sine: "sine", Sine: "saw" })',
    'Object.freeze({ Sine: "sine", get Saw() { throw new Error("never execute") } })',
    'Object.freeze({ Sine: "sine", Saw: getValue() })',
    'Object.freeze({ Sine: "sine", ...other })',
    'Object.freeze({ Sine: "sine", "0": "zero" })',
    'Object.freeze({ Sine: "sine", __proto__: "saw" })',
  ]) {
    assert.deepEqual(
      readControls(`const Wave = ${object}; const waveform = Wave.Sine;`)
        .controls,
      [],
    );
  }
  assert.deepEqual(
    readControls(
      `const Object = { freeze: x => x }; ${waveCode} const waveform = Wave.Sine;`,
    ).controls,
    [],
  );
  assert.deepEqual(
    readControls(`const waveform = Wave.Sine; ${waveCode}`).controls,
    [],
  );
  assert.deepEqual(
    readControls(
      `${waveCode}\nfunction voice() { const waveform = Wave.Sine; }`,
    ).controls,
    [],
  );
  assert.equal(
    readControls(`${waveCode}\nconst waveform = Wave.Missing;`).errors?.length,
    1,
  );
});

test("multi-enum edits follow the enum declaration order", () => {
  const code = `${waveCode}\nconst layers = [Wave.Saw, Wave.Sine]; // bass`;
  const edit = changeControl(code, "layers", {
    type: "set",
    value: ["sawtooth", "triangle", "sine"],
  });
  assert(edit);
  const changed = editSource(code, [edit]);
  assert.match(changed, /\[Wave.Sine, Wave.Triangle, Wave.Saw\]; \/\/ bass/);
  assert.deepEqual(
    readControls(changed).controls.map(({ kind, value }) => [kind, value]),
    [["multi-enum", ["sine", "triangle", "sawtooth"]]],
  );
  assert(changeControl(code, "layers", { type: "set", value: [] }));
  assert.equal(
    changeControl(code, "layers", { type: "set", value: ["other"] }),
    undefined,
  );
  for (const expression of [
    "[]",
    "[Wave.Sine, Other.Saw]",
    "[Wave.Sine, ...other]",
    "[Wave.Sine, , Wave.Saw]",
  ]) {
    assert.deepEqual(
      readControls(`${waveCode}\nconst layers = ${expression}`).controls,
      [],
    );
  }
});

test("fractional knobs and sliders keep their mode at whole values", () => {
  const code =
    "const gain = 0.2;\nconst pan = 0.5; // @slider -1..1\nconst step = 1; // @slider 0.0..4\nconst repeats = 2;\nconst count = 1; // @slider 0..4";
  const controls = readControls(code).controls;
  assert.deepEqual(
    controls.map((c) => "integer" in c && c.integer),
    [false, false, false, true, true],
  );
  for (const name of ["gain", "pan"]) {
    const edit = changeControl(code, name, { type: "set", value: 0 });
    assert(edit);
    const updated = editSource(code, [edit]);
    assert.match(updated, / = 0\.0;/);
    assert(changeControl(updated, name, { type: "set", value: 0.1 }));
  }
  assert.equal(
    changeControl(code, "repeats", { type: "set", value: 2.5 }),
    undefined,
  );
  assert.equal(
    changeControl(code, "count", { type: "set", value: 1.5 }),
    undefined,
  );
});

test("clearing all choices adds a durable enum annotation and preserves comments and CRLF", () => {
  const code = `${waveCode}\r\n  let layers = [Wave.Sine]; // voice\r\nconst other = 2;`;
  const edit = changeControl(code, "layers", { type: "set", value: [] });
  assert(edit);
  const cleared = editSource(code, [edit]);
  assert.match(
    cleared,
    / {2}\/\/ @multi Wave\r\n {2}let layers = \[\]; \/\/ voice/,
  );
  const control = readControls(cleared).controls.find(
    (c) => c.name === "layers",
  );
  assert.equal(control?.kind, "multi-enum");
  assert.deepEqual(control?.value, []);
  assert.equal(
    changeControl(cleared, "layers", { type: "set", value: [] }),
    undefined,
  );
  const enabled = changeControl(cleared, "layers", {
    type: "set",
    value: ["sawtooth"],
  });
  assert(enabled);
  assert.match(
    editSource(cleared, [enabled]),
    /@multi Wave\r\n {2}let layers = \[Wave.Saw\]/,
  );
});

test("explicit empty arrays read both inline and leading annotations", () => {
  for (const declaration of [
    "let layers = []; // @multi Wave",
    "// @multi Wave\nlet layers = [];",
  ]) {
    const code = `${waveCode}\n${declaration}`;
    const result = readControls(code);
    assert.equal(result.errors, undefined);
    assert.equal(result.controls[0].kind, "multi-enum");
    const edit = changeControl(code, "layers", {
      type: "set",
      value: ["sawtooth", "sine"],
    });
    assert(edit);
    const updated = editSource(code, [edit]);
    assert.match(updated, /\[Wave.Sine, Wave.Saw\]/);
    assert.equal((updated.match(/@multi/g) ?? []).length, 1);
    assert.equal(updated.includes("order="), false);
    assert.equal(
      readControls(`${waveCode}\nlet layers = [];`).controls.length,
      0,
    );
  }
});

test("reordering stores all choices including disabled entries in one source edit", () => {
  const code = `${waveCode}\nconst layers = [Wave.Sine, Wave.Saw]; // voice`;
  const moved = changeControl(code, "layers", {
    type: "reorder",
    order: ["Saw", "Triangle", "Sine"],
  });
  assert(moved);
  const changed = editSource(code, [moved]);
  assert.match(changed, /@multi Wave order=Saw,Triangle,Sine/);
  assert.match(changed, /\[Wave.Saw, Wave.Sine\]; \/\/ voice/);
  const control = readControls(changed).controls[0];
  assert.equal(control.kind, "multi-enum");
  if (control.kind !== "multi-enum") return;
  assert.deepEqual(
    control.options.map((option) => option.key),
    ["Saw", "Triangle", "Sine"],
  );
  const off = changeControl(changed, "layers", { type: "set", value: [] });
  assert(off);
  const cleared = editSource(changed, [off]);
  assert.match(cleared, /order=Saw,Triangle,Sine/);
  const enabled = changeControl(cleared, "layers", {
    type: "set",
    value: ["sine", "triangle", "sawtooth"],
  });
  assert(enabled);
  assert.match(
    editSource(cleared, [enabled]),
    /\[Wave.Saw, Wave.Triangle, Wave.Sine\]/,
  );
  const inverse = {
    start: moved.start,
    end: moved.start + moved.text.length,
    text: code.slice(moved.start, moved.end),
  };
  assert.equal(editSource(changed, [inverse]), code);
  assert.equal(
    changeControl(changed, "layers", {
      type: "reorder",
      order: ["Saw", "Triangle", "Sine"],
    }),
    undefined,
  );
  assert.equal(
    changeControl(code, "layers", { type: "reorder", order: ["Sine"] }),
    undefined,
  );
  assert.equal(
    changeControl(code, "layers", {
      type: "reorder",
      order: ["Sine", "Sine", "Saw"],
    }),
    undefined,
  );
});

test("disabled-only reorders and quoted enum keys survive annotation round trips", () => {
  const code =
    'const Fx = Object.freeze({ Echo: "echo", "Soft, wide chorus": "chorus", Crush: "crush" });\nlet effects = [Fx.Echo];';
  const edit = changeControl(code, "effects", {
    type: "reorder",
    order: ["Echo", "Crush", "Soft, wide chorus"],
  });
  assert(edit);
  const changed = editSource(code, [edit]);
  assert.match(changed, /order=Echo,Crush,"Soft, wide chorus"/);
  assert.match(changed, /effects = \[Fx.Echo\]/);
  const add = changeControl(changed, "effects", {
    type: "set",
    value: ["chorus", "echo"],
  });
  assert(add);
  assert.match(
    editSource(changed, [add]),
    /\[Fx.Echo, Fx\["Soft, wide chorus"\]\]/,
  );
});

test("reading order metadata normalizes removed and new fields without executing code", () => {
  const code = `${waveCode}\nlet layers = [Wave.Saw]; // @multi Wave order=Saw,Removed,Saw`;
  const control = readControls(code).controls[0];
  assert.equal(control.kind, "multi-enum");
  if (control.kind !== "multi-enum") return;
  assert.deepEqual(
    control.options.map((option) => option.key),
    ["Saw", "Sine", "Triangle"],
  );
  const edit = changeControl(code, "layers", { type: "set", value: ["sine"] });
  assert(edit);
  assert.match(editSource(code, [edit]), /order=Saw,Sine,Triangle/);
  for (const declaration of [
    "let layers = []; // @multi Missing",
    "let layers = 1; // @multi Wave",
    "let layers = [Wave.Sine, Wave.Sine]",
    "let layers = []; // @multi Wave order=getOptions()",
  ]) {
    assert.equal(readControls(`${waveCode}\n${declaration}`).errors?.length, 1);
  }
});

test("comma bindings and ignore isolate annotations to the intended array", () => {
  const code = `${waveCode}\n// @multi Wave\nconst a = [Wave.Sine], b = [Wave.Saw];`;
  const edit = changeControl(code, "b", {
    type: "reorder",
    order: ["Saw", "Triangle", "Sine"],
  });
  assert(edit);
  const changed = editSource(code, [edit]);
  assert.equal(readControls(changed).valid, true);
  const controls = readControls(changed).controls;
  const a = controls.find((control) => control.name === "a");
  const b = controls.find((control) => control.name === "b");
  assert(a?.kind === "multi-enum" && b?.kind === "multi-enum");
  assert.deepEqual(
    a.options.map((option) => option.key),
    ["Sine", "Triangle", "Saw"],
  );
  assert.deepEqual(
    b.options.map((option) => option.key),
    ["Saw", "Triangle", "Sine"],
  );
  const hide = ignoreControl(changed, "b");
  assert(hide);
  assert.deepEqual(
    readControls(editSource(changed, [hide])).controls.map(
      (control) => control.name,
    ),
    ["a"],
  );
});

function mustMove(
  code: string,
  name: string,
  target: string,
  placement: "before" | "after",
) {
  const edit = moveControl(code, name, target, placement);
  assert(
    edit,
    `moveControl(${name}, ${target}, ${placement}) returned undefined`,
  );
  return edit;
}

test("moveControl swaps two adjacent top-level declarations", () => {
  const code = "const a = 1;\nconst b = 2;\nnote('c3')";
  const edit = moveControl(code, "a", "b", "after");
  assert(edit);
  const moved = editSource(code, [edit]);
  assert.equal(moved, "const b = 2;\nconst a = 1;\nnote('c3')");
  assert.deepEqual(
    readControls(moved).controls.map((c) => c.name),
    ["b", "a"],
  );
});

test("moveControl relocates across intervening statements", () => {
  const code = "const a = 1;\nconst b = 2;\nconst c = 3;";
  const moved = editSource(code, [mustMove(code, "a", "c", "after")]);
  assert.equal(moved, "const b = 2;\nconst c = 3;\nconst a = 1;");
  const reversed = editSource(code, [mustMove(code, "c", "a", "before")]);
  assert.equal(reversed, "const c = 3;\nconst a = 1;\nconst b = 2;");
});

test("moveControl reorders declarators inside one comma declaration", () => {
  const code = "const a = 1, b = 2, c = 3;";
  const moved = editSource(code, [mustMove(code, "a", "c", "after")]);
  assert.equal(moved, "const b = 2, c = 3, a = 1;");
  assert.deepEqual(
    readControls(moved).controls.map((c) => c.name),
    ["b", "c", "a"],
  );
});

test("moveControl moves a multi-binding declaration with its siblings", () => {
  const code = "const a = 1, b = 2;\nconst c = 3;";
  const moved = editSource(code, [mustMove(code, "c", "a", "before")]);
  assert.equal(moved, "const c = 3;\nconst a = 1, b = 2;");
  assert.deepEqual(
    readControls(moved).controls.map((c) => c.name),
    ["c", "a", "b"],
  );
});

test("moveControl preserves preceding //@ignore comments", () => {
  const code = "//@ignore\nconst hidden = 2;\nconst a = 1;\nconst b = 2;\n";
  const moved = editSource(code, [mustMove(code, "b", "a", "before")]);
  assert.equal(
    moved,
    "//@ignore\nconst hidden = 2;\nconst b = 2;\nconst a = 1;\n",
  );
  assert.deepEqual(
    readControls(moved).controls.map((c) => c.name),
    ["b", "a"],
  );
});

test("moveControl carries an ignore marker that precedes a declarator", () => {
  const code =
    "const a = 1, \n//@ignore\nb = 2, \nc = 3;\nnote('c3').gain(a + c)";
  const moved = editSource(code, [mustMove(code, "a", "c", "after")]);
  assert.deepEqual(
    readControls(moved).controls.map((c) => c.name),
    ["c", "a"],
  );
});

test("moveControl preserves CRLF line endings", () => {
  const code = "const a = 1;\r\nconst b = 2;\r\n";
  const moved = editSource(code, [mustMove(code, "a", "b", "after")]);
  assert.equal(moved, "const b = 2;\r\nconst a = 1;\r\n");
});

test("moving controls carries leading and inline annotations", () => {
  for (const newline of ["\n", "\r\n"]) {
    const code = [
      waveCode,
      "// @slider vertical 0..1",
      "const amount = 0.5;",
      "const layers = []; // @multi Wave order=Saw,Sine,Triangle",
      "const count = 2;",
    ].join(newline);
    for (const [name, target, placement] of [
      ["amount", "count", "after"],
      ["count", "amount", "before"],
      ["amount", "count", "before"],
      ["count", "amount", "after"],
      ["layers", "amount", "before"],
      ["amount", "layers", "after"],
    ] as const) {
      const changed = editSource(code, [
        mustMove(code, name, target, placement),
      ]);
      const parsed = readControls(changed);
      assert.equal(parsed.valid, true);
      assert.equal(parsed.errors, undefined);
      assert.equal(
        parsed.controls.find((c) => c.name === "amount")?.kind,
        "slider",
      );
      const layers = parsed.controls.find((c) => c.name === "layers");
      assert(layers?.kind === "multi-enum");
      assert.deepEqual(
        layers.options.map((option) => option.key),
        ["Saw", "Sine", "Triangle"],
      );
      assert.equal(
        parsed.controls.find((c) => c.name === "count")?.kind,
        "number",
      );
      assert.equal((changed.match(/@slider/g) ?? []).length, 1);
      assert.equal((changed.match(/@multi/g) ?? []).length, 1);
    }
  }
});

test("moving annotated comma bindings preserves per-binding metadata", () => {
  for (const code of [
    "const a = 0.5, // @slider vertical 0..1\nb = 2, c = 3;",
    "const a = 2,\n// @slider vertical 0..1\nb = 0.5, c = 3;",
    "const a = 2, b = 3, c = 0.5; // @slider vertical 0..1",
  ]) {
    for (const [name, target, placement] of [
      ["a", "c", "after"],
      ["c", "a", "before"],
    ] as const) {
      const original = readControls(code);
      const changed = editSource(code, [
        mustMove(code, name, target, placement),
      ]);
      const parsed = readControls(changed);
      assert.equal(parsed.valid, true, changed);
      assert.equal(parsed.errors, undefined, changed);
      for (const control of original.controls) {
        const moved = parsed.controls.find((c) => c.name === control.name);
        assert.equal(moved?.kind, control.kind, changed);
        assert.equal(moved?.value, control.value, changed);
      }
    }
  }
});

test("moving whole comma declarations does not duplicate siblings", () => {
  const code = "const a = 1, b = 2;\nconst c = 3;\nconst d = 4, e = 5;";
  for (const [name, target, placement] of [
    ["a", "c", "after"],
    ["b", "d", "after"],
    ["d", "b", "before"],
    ["e", "a", "before"],
    ["a", "e", "before"],
    ["e", "a", "after"],
  ] as const) {
    const changed = editSource(code, [mustMove(code, name, target, placement)]);
    const parsed = readControls(changed);
    assert.equal(parsed.valid, true, changed);
    assert.deepEqual(
      parsed.controls.map((c) => c.name).sort(),
      ["a", "b", "c", "d", "e"],
      changed,
    );
  }
});

test("shorthand objects compose local controls without losing their source edits", () => {
  const code = `let amount = 0.3, enabled = true;
const cutoff = 600 // @slider 100..2000
export const voice = {enabled, amount, cutoff};
voice.enabled ? note("c3").gain(voice.amount) : silence`;
  const result = readControls(code);
  assert.equal(result.valid, true);
  assert.deepEqual(
    result.compositions?.map(({ name, members }) => ({ name, members })),
    [{ name: "voice", members: ["enabled", "amount", "cutoff"] }],
  );
  assert.equal(result.controls.length, 3);
  assert.equal(
    code.slice(result.compositions[0].start, result.compositions[0].end),
    "{enabled, amount, cutoff}",
  );
  const change = changeControl(code, "amount", { type: "set", value: 0.7 });
  assert(change);
  const edited = editSource(code, [change]);
  assert.match(edited, /amount = 0.7/);
  assert.deepEqual(readControls(edited).compositions?.[0].members, [
    "enabled",
    "amount",
    "cutoff",
  ]);
});

test("group conflicts are isolated; nesting is rejected irrespective of declaration order", () => {
  const result = readControls(`const a=1,b=2,c=3;
let nested={first,c}; let first={a,b}; let overlap={b,c}; let repeated={c,c}; let healthy={c};`);
  assert.deepEqual(
    result.compositions?.map((group) => group.name),
    ["first", "healthy"],
  );
  assert.deepEqual(
    result.issues?.map((issue) => issue.name),
    ["nested", "overlap", "repeated"],
  );
  assert.deepEqual(
    result.controls.map((control) => control.name),
    ["a", "b", "c"],
  );
  const self = readControls("const a=1; let self={self,a}");
  assert.match(self.issues?.[0].message ?? "", /cannot contain/);
});

test("ordinary objects, aliases, spreads, computed fields, ignored groups and foreign bindings stay ordinary code", () => {
  const code = `import {remote} from './other.strudel';
const a=1,b=true;
const ordinary={a,missing}; const alias={value:a}; const spread={...ordinary};
const computed={['a']:a}; const foreign={a,remote}; const empty={};
// @ignore
const hidden={a,b};
function local(){const inner=1; const group={inner};}
const Wave=Object.freeze({Sine:'sine',Saw:'sawtooth'});
const waveform=Wave.Sine;
const valid={a,b,waveform};`;
  const result = readControls(code);
  assert.deepEqual(
    result.compositions?.map((group) => group.name),
    ["valid"],
  );
  assert.equal(result.issues, undefined);
  assert.equal(result.errors, undefined);
});

test("reordering group members edits object references, preserves comments and rejects cross-group moves", () => {
  const code =
    "const a=0.1,b=0.2,c=true,d=4;\r\nlet voice={a, /* keep */ b,c};";
  const edit = moveControl(code, "c", "a", "before");
  assert(edit);
  const next = editSource(code, [edit]);
  assert.equal(
    next,
    "const a=0.1,b=0.2,c=true,d=4;\r\nlet voice={c, /* keep */ a,b};",
  );
  assert.deepEqual(readControls(next).compositions?.[0].members, [
    "c",
    "a",
    "b",
  ]);
  assert.equal(moveControl(code, "a", "d", "after"), undefined);
  assert.equal(moveControl(code, "d", "a", "before"), undefined);
  const ignore = ignoreControl(code, "a");
  assert(ignore);
  const hidden = editSource(code, [ignore]);
  assert.equal(readControls(hidden).compositions, undefined);
  assert.deepEqual(
    readControls(hidden).controls.map((control) => control.name),
    ["b", "c", "d"],
  );
});

test("customization edits round trip slider metadata without changing expressions or prose", () => {
  const source =
    "// voice\r\n  export const cutoff = (600 * 2); // brightness\r\nnote('c3').lpf(cutoff)";
  const before = readControlCustomization(source, "cutoff");
  const settings = initialCustomization(before.control, [], "slider");
  settings.values = {
    presentation: "vertical",
    range: ["100.0", "8000"],
  };
  const edit = configureControl(source, "cutoff", settings, before.settings);
  assert(edit);
  const changed = editSource(source, [edit]);
  assert(changed.includes("export const cutoff = (600 * 2); // brightness"));
  assert(changed.includes("// voice\r\n"));
  assert(!/(?<!\r)\n/.test(changed));
  assert.deepEqual(
    readControlCustomization(changed, "cutoff").settings,
    settings,
  );
  const control = readControls(changed).controls[0];
  assert.equal(control.kind, "slider");
  assert(control.kind === "slider");
  assert.equal(control.integer, false);
  assert.equal(configureControl(changed, "cutoff", settings), undefined);
  const plain = configureControl(changed, "cutoff", {
    kind: "number",
    values: { step: "1", min: "", max: "", split: "0" },
  });
  assert(plain);
  const restored = editSource(changed, [plain]);
  assert(!restored.includes("@slider"));
  assert(restored.includes("export const cutoff = (600 * 2); // brightness"));
  assert.equal(readControls(restored).controls[0].kind, "number");
});

test("customizations replace leading and trailing annotations without accumulating markers", () => {
  for (const source of [
    "// @slider default 0.0..2\nconst gain = 1; // voice",
    "const gain = 1; // @slider 0.0..2\n// voice",
  ]) {
    const { control, settings } = readControlCustomization(source, "gain");
    assert.equal(settings.values.range[0], "0.0");
    const next = {
      ...settings,
      values: { ...settings.values, presentation: "vertical" },
    };
    const edit = configureControl(source, "gain", next);
    assert(edit);
    const code = editSource(source, [edit]);
    assert.equal((code.match(/@slider/g) ?? []).length, 1);
    assert.equal(code.split("\n").length, source.split("\n").length);
    assert(code.includes("// voice"));
    assert.deepEqual(readControlCustomization(code, "gain").settings, next);
    assert.equal(readControls(code).controls[0].value, control.value);
  }
});

test("editing each comma binding preserves shared settings and neighboring declarations", () => {
  for (const prefix of ["", "// @slider vertical 0..4\n"]) {
    for (const name of ["a", "b", "c"]) {
      const source = `${prefix}export const a = 1, /* neighbor */ b = 2, c = 3;\nconst next = true;`;
      const original = readControls(source).controls;
      for (const kind of ["number", "slider"] as const) {
        const current = readControlCustomization(source, name);
        const settings = initialCustomization(current.control, [], kind);
        if (kind === "slider")
          settings.values = {
            presentation: "horizontal",
            range: ["0.0", "10"],
          };
        const edit = configureControl(source, name, settings);
        const code = edit ? editSource(source, [edit]) : source;
        assert.equal(readControls(code).valid, true);
        assert.equal(readControls(code).errors, undefined);
        assert(code.includes("/* neighbor */"));
        assert(code.includes("const next = true;"));
        for (const sibling of original.filter(
          (control) => control.name !== name,
        )) {
          const updated = readControlCustomization(code, sibling.name);
          assert.equal(updated.control.value, sibling.value);
          assert.deepEqual(
            updated.settings,
            readControlCustomization(source, sibling.name).settings,
          );
        }
        assert.deepEqual(
          readControlCustomization(code, name).settings,
          settings,
        );
      }
    }
  }
});

test("binding-local annotations are not applied to comma siblings", () => {
  for (const source of [
    "const a = 0.5, // @slider vertical\nb = 2, c = 3;",
    "export const a = 2,\n// @slider vertical\nb = 0.5, c = 3;",
    "const a = 2, b = 3, c = 0.5; // @slider vertical",
  ]) {
    const before = readControls(source).controls;
    const target = before.find((control) => control.kind === "slider");
    assert(target);
    const edit = configureControl(source, target.name, {
      kind: "number",
      values: { step: "1", min: "", max: "", split: "0" },
    });
    assert(edit);
    const after = readControls(editSource(source, [edit]));
    assert.equal(after.errors, undefined);
    assert.deepEqual(
      after.controls.map((control) => [
        control.name,
        control.kind,
        control.value,
      ]),
      before.map((control) => [control.name, "number", control.value]),
    );
  }
});

test("settings reject invalid ranges, unsupported fields and stale source metadata", () => {
  const source = "const gain = 0.5; // @slider 0..1";
  const { settings } = readControlCustomization(source, "gain");
  for (const range of [
    ["1", "0"],
    ["NaN", "1"],
    ["0", "Infinity"],
    ["", "1"],
  ]) {
    assert.throws(() =>
      configureControl(source, "gain", {
        ...settings,
        values: { ...settings.values, range },
      }),
    );
  }
  assert.throws(() =>
    configureControl(source, "gain", {
      ...settings,
      values: {
        ...settings.values,
        presentation: "vertical\nconst injected = 1",
      },
    }),
  );
  assert.throws(() =>
    configureControl(source, "gain", {
      ...settings,
      values: { ...settings.values, bogus: "x" },
    }),
  );
  assert.throws(() => configureControl("const flag = true", "flag", settings));
  const next = {
    ...settings,
    values: { ...settings.values, presentation: "vertical" },
  };
  assert.throws(
    () =>
      configureControl(source.replace("0..1", "-1..1"), "gain", next, settings),
    /changed in the source/,
  );
  assert.throws(
    () => configureControl("const gain =", "gain", next),
    /changed/,
  );
  assert.throws(
    () => configureControl(source.replace("0.5", "2"), "gain", next),
    /changed/,
  );
});

test("multiple choice settings reorder selected and unselected keys and retain quoted names", () => {
  const source =
    'const FX = Object.freeze({ Echo: "echo", "Soft chorus": "chorus", Crush: "crush" });\nlet layers = [FX.Echo, FX.Crush]; // voice';
  const { settings } = readControlCustomization(source, "layers");
  settings.values.order = ["Crush", "Soft chorus", "Echo"];
  const edit = configureControl(source, "layers", settings);
  assert(edit);
  const code = editSource(source, [edit]);
  assert(code.includes('order=Crush,"Soft chorus",Echo'));
  assert(code.includes("[FX.Crush, FX.Echo]; // voice"));
  assert.deepEqual(readControlCustomization(code, "layers").settings, settings);
  assert.deepEqual(readControls(code).controls[0].value, ["crush", "echo"]);
  assert.throws(() =>
    configureControl(source, "layers", {
      ...settings,
      values: { order: ["Echo", "Echo", "Crush"] },
    }),
  );
});

test("new descriptor fields are parsed, validated and serialized through the shared registry", () => {
  const field = {
    id: "testVariant",
    label: "Test variant",
    type: "select" as const,
    defaultValue: "variant-a",
    options: [
      { value: "variant-a", label: "A" },
      { value: "variant-b", label: "B" },
    ],
    accepts: (token: string) => token.startsWith("variant-"),
    parse: (token: string) => token,
    token: (value: string | string[]) => String(value),
  };
  // The dialog uses this same fields array.
  sliderFields.push(field);
  try {
    const source = "const gain = 0.5; // @slider variant-a";
    const { control, settings } = readControlCustomization(source, "gain");
    assert(
      customizationsFor(control)
        .find((item) => item.id === "slider")
        ?.fields.includes(field),
    );
    assert.equal(settings.values.testVariant, "variant-a");
    const next = {
      ...settings,
      values: { ...settings.values, testVariant: "variant-b" },
    };
    const edit = configureControl(source, "gain", next);
    assert(edit);
    assert.deepEqual(
      readControlCustomization(editSource(source, [edit]), "gain").settings,
      next,
    );
  } finally {
    sliderFields.splice(sliderFields.indexOf(field), 1);
  }
});

test("narrowing slider bounds clamps the source value in the same edit as its settings", () => {
  for (const [source, range, value] of [
    ["const gain = 0.5; // @slider 0..1", ["0", "0.2"], 0.2],
    ["const gain = (1 / 2); // @slider 0..1", ["0.7", "1"], 0.7],
    ["const gain = -50; // voice", ["-20", "-10"], -20],
    ["const gain = 100.5; // @slider 0..200", ["0", "80"], 80],
  ] as const) {
    const before = readControlCustomization(source, "gain");
    const settings = initialCustomization(before.control, [], "slider");
    settings.values.range = [...range];
    const edit = configureControl(source, "gain", settings, before.settings);
    assert(edit);
    const code = editSource(source, [edit]);
    const updated = readControlCustomization(code, "gain");
    assert.equal(updated.control.value, value);
    assert.deepEqual(updated.settings, settings);
    assert.equal(readControls(code).errors, undefined);
    if (source.includes("// voice")) assert(code.includes("// voice"));
    if (source.includes("100.5")) {
      assert(code.includes("80.0"));
      assert(updated.control.kind === "slider");
      assert.equal(updated.control.integer, false);
    }
  }
  const source = "const gain = (1 / 2); // @slider 0..1";
  const before = readControlCustomization(source, "gain");
  before.settings.values.range = ["0.1", "0.9"];
  const edit = configureControl(source, "gain", before.settings);
  assert(edit);
  assert(editSource(source, [edit]).includes("(1 / 2)"));
});

test("settings are offered only for controls with working customization choices", () => {
  const source = `${waveCode}\nconst count = 2;\nconst amount = 0.5; // @slider\nconst enabled = true;\nconst wave = Wave.Sine;\nconst layers = [Wave.Sine];`;
  assert.deepEqual(
    readControls(source).controls.map((control) => [
      control.kind,
      hasControlCustomizations(control),
    ]),
    [
      ["number", true],
      ["slider", true],
      ["boolean", true],
      ["enum", true],
      ["multi-enum", true],
    ],
  );
});

test("knobs default to step one and accept fractional steps on whole-number values", () => {
  for (const value of ["2", "0.5", "2.0"]) {
    const { control, settings } = readControlCustomization(
      `const gain = ${value}`,
      "gain",
    );
    assert(control.kind === "number");
    assert.equal(control.step, 1);
    assert.deepEqual(settings, {
      kind: "number",
      values: { step: "1", min: "", max: "", split: "0" },
    });
  }
  for (const step of ["0.25", "1e-7", "10"]) {
    for (const source of [
      `// @knob step=${step}\nconst gain = 2;`,
      `const gain = 2; // @knob step=${step}`,
    ]) {
      const { control, settings } = readControlCustomization(source, "gain");
      assert(control.kind === "number");
      assert.equal(control.step, Number(step));
      assert.equal(control.integer, Number.isInteger(Number(step)));
      assert.equal(settings.values.step, step);
      const edit = changeControl(source, "gain", {
        type: "set",
        value: 2 + Number(step),
      });
      assert(edit);
      const changed = editSource(source, [edit]);
      assert.equal(readControls(changed).controls[0].value, 2 + Number(step));
      assert.equal(
        readControlCustomization(changed, "gain").settings.values.step,
        step,
      );
    }
  }
});

test("knob step edits preserve expressions and prose, reset defaults and switch control type", () => {
  let source = "// voice\r\nconst gain = (1 / 2); // keep me\r\n";
  const apply = (kind: string, values: Record<string, string | string[]>) => {
    if (kind === "number") values = { min: "", max: "", split: "0", ...values };
    const edit = configureControl(source, "gain", { kind, values });
    assert(edit);
    source = editSource(source, [edit]);
    assert(source.includes("const gain = (1 / 2); // keep me"));
    assert(!/(?<!\r)\n/.test(source));
    assert.deepEqual(readControlCustomization(source, "gain").settings, {
      kind,
      values,
    });
  };
  apply("number", { step: "0.1" });
  apply("number", { step: "0.25" });
  assert.equal((source.match(/@knob/g) ?? []).length, 1);
  apply("number", { step: "1" });
  assert(!source.includes("@knob"));
  apply("slider", { presentation: "vertical", range: ["0", "1"] });
  apply("number", { step: "0.01" });
  assert(!source.includes("@slider"));
});

test("invalid knob steps fail in both annotations and the settings schema", () => {
  const source = "const gain = 1;";
  for (const step of [
    "",
    "0",
    "-1",
    "Infinity",
    "NaN",
    "1e999",
    "1e-999",
    "1 + 2",
  ]) {
    assert.throws(() =>
      configureControl(source, "gain", { kind: "number", values: { step } }),
    );
    const result = readControls(
      `${source} // @knob step=${step}\nconst valid = true;`,
    );
    assert.equal(result.errors?.length, 1);
    assert.deepEqual(
      result.controls.map(({ name }) => name),
      ["valid"],
    );
  }
  for (const annotation of [
    "@knob step=1 step=2",
    "@knob unknown",
    "@knob step=1\n// @knob step=2",
    "@knob step=1\n// @slider",
    "@slider\n// @knob step=1",
  ]) {
    assert.equal(
      readControls(`// ${annotation}\nconst gain = 1;`).errors?.length,
      1,
    );
  }
  assert.equal(
    readControls("// @knob step=0\n// @ignore\nconst gain = 1;").errors,
    undefined,
  );
});

test("editing a shared knob annotation keeps sibling steps and rejects stale settings", () => {
  const source = "// @knob step=0.1\nexport const a = 1, b = 2;";
  const initial = readControlCustomization(source, "a").settings;
  const next = {
    kind: "number",
    values: { step: "10", min: "", max: "", split: "0" },
  };
  const edit = configureControl(source, "a", next, initial);
  assert(edit);
  const changed = editSource(source, [edit]);
  assert.deepEqual(readControlCustomization(changed, "b").settings, initial);
  assert.deepEqual(readControlCustomization(changed, "a").settings, next);
  assert.throws(
    () =>
      configureControl(
        changed,
        "a",
        { kind: "number", values: { step: "2", min: "", max: "", split: "0" } },
        initial,
      ),
    /changed in the source/,
  );
});

test("bounded knobs clamp source edits and follow the 7-to-5 o'clock arc", () => {
  const source = "const gain = 50; // @knob min=0 max=100";
  const control = readControls(source).controls[0];
  assert(control.kind === "number");
  assert.equal(knobAngle(0, control), -150);
  assert.equal(knobAngle(50, control), 0);
  assert.equal(knobAngle(100, control), 150);
  for (const [input, expected] of [
    [-100, 0],
    [200, 100],
  ]) {
    const edit = changeControl(source, "gain", { type: "set", value: input });
    assert(edit);
    assert.equal(
      readControls(editSource(source, [edit])).controls[0].value,
      expected,
    );
    assert.equal(knobAngle(input, control), expected === 0 ? -150 : 150);
  }
  // The unsnapped movement accumulator clamps at the boundary, so reversal is immediate.
  assert.equal(clampKnobValue(clampKnobValue(1000, control) - 1, control), 99);
  assert.equal(clampKnobValue(clampKnobValue(-1000, control) + 1, control), 1);
});

test("split snaps on the bounded arc and on every turn of an unlimited knob", () => {
  for (const annotation of [
    "step=1 min=0 max=100 split=10",
    "step=2 split=4",
  ]) {
    const control = readControls(`const gain = 0; // @knob ${annotation}`)
      .controls[0];
    assert(control.kind === "number");
    const increment = knobIncrement(control);
    assert.equal(increment, control.min === undefined ? 6 : 10);
    assert.equal(normalizeKnobValue(increment * 0.49, control), 0);
    assert.equal(normalizeKnobValue(increment * 0.51, control), increment);
    assert.equal(normalizeKnobValue(increment * 2.4, control), increment * 2);
    if (control.min === undefined) {
      assert.equal(normalizeKnobValue(-7, control), -6);
      assert.equal(normalizeKnobValue(25, control), 24);
      assert.equal(knobAngle(24, control), 0);
      assert.equal(knobAngle(6, control), 90);
    }
  }
  const free = readControls("const gain = 0.0; // @knob step=0.1 split=0")
    .controls[0];
  assert(free.kind === "number");
  assert.equal(normalizeKnobValue(0.12345, free), 0.12345);
  for (let split = 1; split <= 10; split++) {
    const source = `const gain = 0; // @knob min=-0.1 max=0.2 split=${split}`;
    const control = readControls(source).controls[0];
    assert(control.kind === "number");
    assert.equal(normalizeKnobValue(-1, control), -0.1);
    assert.equal(normalizeKnobValue(1, control), 0.2);
    const value = normalizeKnobValue(0.05, control);
    const edit = changeControl(source, "gain", { type: "set", value });
    if (edit) {
      const updated = readControls(editSource(source, [edit])).controls[0];
      assert.equal(updated.value, value);
    }
    assert.equal(normalizeKnobValue(value, control), value);
  }
});

test("knob limits and splits round trip, clamp and snap in a single settings edit", () => {
  for (const [value, expected] of [
    [150, 100],
    [-1, 0],
    [46, 50],
  ]) {
    const source = `const gain = ${value}; // voice`;
    const settings = readControlCustomization(source, "gain").settings;
    settings.values = { ...settings.values, min: "0", max: "100", split: "10" };
    const edit = configureControl(source, "gain", settings);
    assert(edit);
    const code = editSource(source, [edit]);
    assert(code.includes("// voice"));
    const updated = readControlCustomization(code, "gain");
    assert.equal(updated.control.value, expected);
    assert.deepEqual(updated.settings, settings);
    assert.equal(configureControl(code, "gain", settings), undefined);
    // Clear bounds without clearing Split: the same control becomes unlimited.
    const unlimited = {
      ...settings,
      values: { ...settings.values, min: "", max: "" },
    };
    const freeEdit = configureControl(code, "gain", unlimited);
    assert(freeEdit);
    const free = readControlCustomization(editSource(code, [freeEdit]), "gain");
    assert.deepEqual(free.settings, unlimited);
    assert(free.control.kind === "number");
    assert.equal(free.control.min, undefined);
    assert.equal(free.control.split, 10);
  }
  const source = "const gain = 99; // @knob min=0 max=10 split=5";
  const settings = readControlCustomization(source, "gain").settings;
  const edit = configureControl(source, "gain", settings);
  assert(edit);
  assert.equal(readControls(editSource(source, [edit])).controls[0].value, 10);
});

test("knob bounds and split validation are shared by code and settings", () => {
  const source = "const gain = 0;";
  const base = readControlCustomization(source, "gain").settings;
  for (const [values, annotation] of [
    [{ min: "0" }, "min=0"],
    [{ max: "1" }, "max=1"],
    [{ min: "2", max: "1" }, "min=2 max=1"],
    [{ min: "1", max: "1" }, "min=1 max=1"],
    [{ min: "-1e308", max: "1e308" }, "min=-1e308 max=1e308"],
    [{ min: "NaN", max: "1" }, "min=NaN max=1"],
    [{ split: "-1" }, "split=-1"],
    [{ split: "11" }, "split=11"],
    [{ split: "1.5" }, "split=1.5"],
    [{ split: "Infinity" }, "split=Infinity"],
  ] as const) {
    assert.throws(() =>
      configureControl(source, "gain", {
        ...base,
        values: { ...base.values, ...values },
      }),
    );
    const result = readControls(
      `${source} // @knob ${annotation}\nconst valid = true;`,
    );
    assert.equal(result.errors?.length, 1, annotation);
    assert.deepEqual(
      result.controls.map(({ name }) => name),
      ["valid"],
    );
  }
  for (const annotation of ["min=0 min=1 max=2", "split=1 split=2"])
    assert.equal(
      readControls(`${source} // @knob ${annotation}`).errors?.length,
      1,
    );
});

test("defaults reset every control kind, including zero, false, fractional numbers and empty arrays", () => {
  for (const [source, name, expected] of [
    ["const gain = 1; // @default 0", "gain", 0],
    ["const gain = 1; // @default 0.25", "gain", 0.25],
    [
      "// @knob min=0 max=10 split=5\n// @default 4\nconst gain = 2;",
      "gain",
      4,
    ],
    ["// @slider 0..1\n// @default 0.25\nconst gain = 1;", "gain", 0.25],
    ["const enabled = true; // @default false", "enabled", false],
    [
      `${waveCode}\nconst wave = Wave.Sine; // @default Wave.Saw`,
      "wave",
      "sawtooth",
    ],
    [`${waveCode}\nconst layers = [Wave.Sine]; // @default []`, "layers", []],
    [
      `${waveCode}\nconst layers = [Wave.Sine, Wave.Saw]; // @default [Wave.Saw, Wave.Sine]`,
      "layers",
      ["sawtooth", "sine"],
    ],
  ] as const) {
    const before = readControlCustomization(source, name);
    assert.equal(canResetControl(before.control), true, source);
    assert.deepEqual(before.control.defaultValue, expected);
    const edit = changeControl(source, name, { type: "reset" });
    assert(edit, source);
    const code = editSource(source, [edit]);
    const after = readControlCustomization(code, name);
    assert.deepEqual(after.control.value, expected);
    assert.equal(canResetControl(after.control), false);
    assert.equal(changeControl(code, name, { type: "reset" }), undefined);
    assert.equal(after.settings.values.default, before.settings.values.default);
  }
  const source = "const gain = 1;";
  assert.equal(canResetControl(readControls(source).controls[0]), false);
  assert.equal(changeControl(source, "gain", { type: "reset" }), undefined);
});

test("default edits round trip with existing annotations, CRLF, prose and no value changes", () => {
  for (const original of [
    "// voice\r\n  const gain = (2 / 4); // @slider 0..1\r\nconst other = true;",
    "// @knob min=0 max=1\n// explanation\nconst gain = 0.5; // voice\n",
    `${waveCode}\n// @multi Wave order=Saw,Sine,Triangle\nconst layers = [Wave.Sine, Wave.Saw]; // voice`,
  ]) {
    let source = original;
    const name = source.includes("layers =") ? "layers" : "gain";
    const originalValue = readControlCustomization(source, name).control.value;
    const expression = name === "layers" ? "[Wave.Saw]" : "0.25";
    for (const value of [
      expression,
      name === "layers" ? "[]" : "0",
      undefined,
    ]) {
      const current = readControlCustomization(source, name);
      const settings = {
        ...current.settings,
        values: { ...current.settings.values },
      };
      if (value === undefined) delete settings.values.default;
      else settings.values.default = value;
      const edit = configureControl(source, name, settings, current.settings);
      assert(edit);
      source = editSource(source, [edit]);
      const after = readControlCustomization(source, name);
      assert.deepEqual(after.settings, settings);
      assert.deepEqual(after.control.value, originalValue);
      assert(source.includes("// voice"));
      if (original.includes("\r\n")) assert(!/(?<!\r)\n/.test(source));
      assert.equal(
        (source.match(/@default/g) ?? []).length,
        value === undefined ? 0 : 1,
      );
      assert.equal(configureControl(source, name, settings), undefined);
    }
    if (name === "gain")
      assert.equal(source.includes("(2 / 4)"), original.includes("(2 / 4)"));
  }
});

test("shared defaults are isolated when one comma binding changes", () => {
  const source = "// @default 0\nconst a = 1, b = 2;";
  const current = readControlCustomization(source, "a");
  const settings = {
    ...current.settings,
    values: { ...current.settings.values, default: "0.5" },
  };
  const edit = configureControl(source, "a", settings);
  assert(edit);
  const code = editSource(source, [edit]);
  assert.equal(readControlCustomization(code, "a").control.defaultValue, 0.5);
  assert.equal(readControlCustomization(code, "b").control.defaultValue, 0);
  const reset = changeControl(code, "a", { type: "reset" });
  assert(reset);
  const changed = editSource(code, [reset]);
  assert.equal(readControlCustomization(changed, "b").control.value, 2);
});

test("default survives changing numeric control types and removing knob bounds", () => {
  let source = "// @knob min=0 max=10\n// @default 2\nconst gain = 4;";
  for (const kind of ["slider", "number"]) {
    const current = readControlCustomization(source, "gain");
    const settings = initialCustomization(current.control, [], kind);
    assert.equal(settings.values.default, "2");
    if (kind === "number") {
      settings.values.min = "";
      settings.values.max = "";
      settings.values.default = "20";
    }
    const edit = configureControl(source, "gain", settings);
    assert(edit);
    source = editSource(source, [edit]);
    const after = readControlCustomization(source, "gain");
    assert.equal(after.control.kind, kind);
    assert.equal(after.control.value, 4);
    assert.equal(after.settings.values.default, settings.values.default);
  }
});

test("defaults reject incompatible values and expressions without executing them", () => {
  for (const [source, name, expression] of [
    ["const gain = 1;", "gain", "Infinity"],
    ["const gain = 1;", "gain", "(() => { throw new Error('executed') })()"],
    ["const gain = 1;", "gain", "globalThis.compromised = 1"],
    ["const gain = 1;", "gain", "true"],
    ["const enabled = true;", "enabled", "1"],
    [`${waveCode}\nconst wave = Wave.Sine;`, "wave", "Wave.Unknown"],
    [
      `${waveCode}\nconst layers = [Wave.Sine];`,
      "layers",
      "[Wave.Sine, Wave.Sine]",
    ],
    ["// @slider 0..1\nconst gain = 0.5;", "gain", "2"],
    ["// @knob min=0 max=10 split=5\nconst gain = 2;", "gain", "3"],
  ]) {
    const before = readControlCustomization(source, name);
    assert.throws(() =>
      configureControl(source, name, {
        ...before.settings,
        values: { ...before.settings.values, default: expression },
      }),
    );
    const result = readControls(
      `${source} // @default ${expression}\nconst valid = false;`,
    );
    assert.equal(result.errors?.length, 1, expression);
    assert(result.controls.some((control) => control.name === "valid"));
  }
  for (const annotation of ["@default", "@default 0\n// @default 1"])
    assert.equal(
      readControls(`// ${annotation}\nconst gain = 2;`).errors?.length,
      1,
    );
});
