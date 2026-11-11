import assert from "node:assert/strict";
import { test } from "node:test";
import {
  controlSources,
  flatPanelLayout,
  flattenControlGroups,
  readControlTree,
  sourceLabel,
} from "./control-tree";
import { changeControl, readControls } from "./controls";
import { editSource } from "./modules";

test("recursive imports preserve file controls and share repeated sources without executing them", async () => {
  const sources: Record<string, string> = {
    "master.strudel":
      "import a from './a.strudel'; import b from './b.strudel'; const gain = 1;",
    "a.strudel":
      "import shared from './shared.strudel'; const gain = 2; export default shared;",
    "b.strudel":
      "import shared from './shared.strudel'; const enabled = true; export default shared;",
    "shared.strudel":
      "const gain = 3; //@ignore\nconst hidden = 4; throw new Error('must not execute'); export default gain;",
  };
  const calls: string[] = [];
  const tree = await readControlTree("master.strudel", async (path) => {
    calls.push(path);
    return sources[path];
  });
  const first = tree.children[0].children[0];
  const repeated = tree.children[1].children[0];
  assert.equal(first.path, repeated.path);
  assert.notEqual(first.id, repeated.id);
  assert.equal(first.repeated, false);
  assert.equal(repeated.repeated, true);
  assert.deepEqual(first.controls, readControls(sources[first.path]).controls);
  assert.deepEqual(repeated.controls, first.controls);
  assert.equal(calls.filter((path) => path === first.path).length, 1);
  assert.deepEqual(
    [...(controlSources(tree).get("gain") ?? [])],
    ["master.strudel", "a.strudel", "shared.strudel"],
  );
  const edit = changeControl(sources[first.path], "gain", 9);
  assert(edit);
  sources[first.path] = editSource(sources[first.path], [edit]);
  const updated = await readControlTree(
    "master.strudel",
    async (path) => sources[path],
  );
  assert.equal(updated.children[0].children[0].controls[0].value, 9);
  assert.equal(updated.children[1].children[0].controls[0].value, 9);
  assert.equal(updated.controls[0].value, 1);
});

test("bad controls, syntax, missing files and circular imports do not discard healthy siblings", async () => {
  const sources: Record<string, string> = {
    "master.strudel":
      "import './invalid.strudel'; import './missing.strudel'; import './cycle.strudel'; import './healthy.strudel';",
    "invalid.strudel": "const unfinished =",
    "cycle.strudel": "import './master.strudel'; const flag = true;",
    "healthy.strudel": "const broken = 1/0; const fine = 2;",
  };
  const tree = await readControlTree("master.strudel", async (path) => {
    if (!(path in sources)) throw new Error("File not found");
    return sources[path];
  });
  assert.match(tree.children[0].error ?? "", /Finish editing/);
  assert.equal(tree.children[1].error, "File not found");
  assert.equal(tree.children[2].children[0].error, "Circular import");
  assert.equal(tree.children[2].controls[0].name, "flag");
  assert.equal(tree.children[3].issues?.[0].name, "broken");
  assert.equal(tree.children[3].controls[0].name, "fine");
});

test("invalid import paths are isolated and repeated declarations from one file stay in one group", async () => {
  const tree = await readControlTree("master.strudel", async (path) =>
    path === "master.strudel"
      ? "import a from './a.strudel'; import { b } from './a.strudel'; import 'outside';"
      : "const gain = 1;",
  );
  assert.equal(tree.children.length, 2);
  assert.equal(tree.children[0].controls[0].name, "gain");
  assert.match(tree.children[1].error ?? "", /relative/);
});

test("same control names use the shortest distinct source suffix", () => {
  const peers = new Set([
    "drums/voice.strudel",
    "bass/voice.strudel",
    "other.strudel",
  ]);
  assert.equal(
    sourceLabel("drums/voice.strudel", peers),
    "drums/voice.strudel",
  );
  assert.equal(sourceLabel("other.strudel", peers), "other.strudel");
});

test("relocating a shared source preserves per-master branch settings and unrelated roots", async () => {
  const { relocatePanelPreferences } = await import("./control-tree");
  const first = JSON.stringify([
    "master.strudel",
    "a.strudel",
    "parts/voice.strudel",
  ]);
  const second = JSON.stringify([
    "master.strudel",
    "b.strudel",
    "parts/voice.strudel",
  ]);
  const result = relocatePanelPreferences(
    {
      pinned: "master.strudel",
      roots: {
        "master.strudel": {
          hidden: { [first]: true },
          collapsed: { [second]: true },
        },
        "other.strudel": { hidden: {}, collapsed: {} },
      },
    },
    "parts",
    "instruments",
  );
  assert.equal(result.pinned, "master.strudel");
  assert.equal(result.roots["master.strudel"].hidden[first], undefined);
  assert.equal(
    result.roots["master.strudel"].hidden[
      JSON.stringify([
        "master.strudel",
        "a.strudel",
        "instruments/voice.strudel",
      ])
    ],
    true,
  );
  assert.equal(
    result.roots["master.strudel"].collapsed[
      JSON.stringify([
        "master.strudel",
        "b.strudel",
        "instruments/voice.strudel",
      ])
    ],
    true,
  );
  assert.deepEqual(result.roots["other.strudel"], {
    hidden: {},
    collapsed: {},
  });
});

test("recursive imports become one independent card per file, preserving cycle errors", async () => {
  const sources: Record<string, string> = {
    "master.strudel":
      "import './a.strudel'; import './b.strudel'; const master = 1;",
    "a.strudel": "import './shared.strudel'; const a = 2;",
    "b.strudel": "import './shared.strudel'; const b = 3;",
    "shared.strudel": "import './master.strudel'; const shared = 4;",
  };
  const tree = await readControlTree(
    "master.strudel",
    async (path) => sources[path],
  );
  const groups = flattenControlGroups(tree);
  assert.deepEqual(
    groups.map((group) => group.path),
    ["master.strudel", "a.strudel", "shared.strudel", "b.strudel"],
  );
  assert(
    groups.every((group) => group.children.length === 0 && !group.repeated),
  );
  assert.equal(
    groups.find((group) => group.path === "shared.strudel")?.controls[0].value,
    4,
  );
  assert.equal(groups[0].error, "Circular import");
  assert.equal(tree.error, undefined);
  const oldLayout = {
    hidden: { '["master.strudel","a.strudel"]': true },
    collapsed: { '["master.strudel","a.strudel","shared.strudel"]': true },
  };
  const layout = flatPanelLayout(oldLayout, groups);
  assert.equal(layout.hidden['["a.strudel"]'], true);
  assert.equal(layout.hidden['["shared.strudel"]'], undefined);
  assert.equal(layout.collapsed['["shared.strudel"]'], true);
  const updated = flatPanelLayout(
    {
      ...layout,
      collapsed: { ...layout.collapsed, '["shared.strudel"]': false },
    },
    groups,
  );
  assert.equal(updated.collapsed['["shared.strudel"]'], false);
});
