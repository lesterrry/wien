import assert from "node:assert/strict";
import test from "node:test";
import { nextUntitledName } from "./snippet-names";

const entries = (...names: string[]) =>
  names.map((name) => ({ id: name, name }));

test("uses the lowest free number, starting at zero", () => {
  assert.equal(nextUntitledName([]), "untitled0.strudel");
  assert.equal(
    nextUntitledName(entries("untitled0.strudel", "untitled2.strudel")),
    "untitled1.strudel",
  );
  assert.equal(
    nextUntitledName(entries("untitled1.strudel")),
    "untitled0.strudel",
  );
});

test("avoids case-insensitive names, JS snippets, and folders", () => {
  assert.equal(
    nextUntitledName(entries("Untitled0.strudel", "untitled1.js", "untitled2")),
    "untitled3.strudel",
  );
});

test("continues after nine and ignores unrelated filenames", () => {
  assert.equal(
    nextUntitledName(
      entries(
        ...Array.from({ length: 10 }, (_, i) => `untitled${i}.strudel`),
        "untitled10-backup.strudel",
      ),
    ),
    "untitled10.strudel",
  );
});
