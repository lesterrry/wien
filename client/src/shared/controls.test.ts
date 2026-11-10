import assert from "node:assert/strict";
import { test } from "node:test";
import { changeControl, ignoreControl, readControls } from "./controls";
import { editSource } from "./modules";

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
  const edit = changeControl(code, "gain", -123456.75);
  assert(edit);
  const changed = editSource(code, [edit]);
  assert.equal(
    changed,
    "const gain = -123456.75; // voice\nnote('c3').gain(gain)",
  );
  assert.equal(readControls(changed).controls[0].value, -123456.75);
  assert.equal(changeControl(code, "gain", Infinity), undefined);
  assert.equal(changeControl(code, "gain", NaN), undefined);
  assert.equal(changeControl(code, "gain", -0.25), undefined);
});

test("ignore adds a reversible comment above the declaration and preserves CRLF", () => {
  const code =
    "// voice\r\n  export const gain = 0.3;\r\nnote('c3').gain(gain)";
  const edit = ignoreControl(code, "gain");
  assert(edit);
  const hidden = editSource(code, [edit]);
  assert.match(hidden, / {2}\/\/@ignore\r\n {2}export const gain/);
  assert.deepEqual(readControls(hidden), { controls: [], valid: true });
  assert.equal(ignoreControl(hidden, "gain"), undefined);
  assert.equal(hidden.replace("  //@ignore\r\n", ""), code);
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
  assert.equal(changeControl("const renamed = 2", "gain", 3), undefined);
  assert.equal(ignoreControl("const gain =", "gain"), undefined);
});
