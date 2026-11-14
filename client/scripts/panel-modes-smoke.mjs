import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import { workspaceWindow } from "./fixtures/onboarding.mjs";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-panel-modes-"));
const root = path.join(temporary, "project");
await fs.mkdir(path.join(root, "lib"), { recursive: true });
const settingsRoot = await fs.realpath(root);
const shared =
  "const level = 0.2; // @knob step=0.01\nconst broken = 1/0; export default note('c3*4').s('sine').gain(level)";
const sources = {
  "main.strudel":
    "import a from './lib/a.strudel'; import b from './lib/b.strudel'; const gain = 0.5; stack(a,b)",
  "lib/a.strudel":
    "import shared from './shared.strudel'; const gain = 0.2; export default shared",
  "lib/b.strudel":
    "import shared from './shared.strudel'; const gain = 0.3; export default shared",
  "lib/shared.strudel": shared,
  "missing-master.strudel":
    "import './lib/missing.strudel'; import './lib/late.strudel'; const rootAmount = 0.4; note('c3')",
  "lib/late.strudel": "const lateAmount = 0.7; export default note('c3')",
};
for (const [file, source] of Object.entries(sources))
  await fs.writeFile(path.join(root, file), source);
const environment = {
  ...process.env,
  WIEN_PROJECT: root,
  WIEN_USER_DATA: path.join(temporary, "state"),
};
delete environment.ELECTRON_RUN_AS_NODE;
let app;
let page;
const errors = [];
try {
  app = await electron.launch({
    args: ["out/main/index.js", "--mute-audio"],
    env: environment,
  });
  page = await workspaceWindow(app);
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  const panel = page.getByRole("complementary", { name: "Snippet controls" });
  const mode = (value) => expect(panel).toHaveAttribute("data-mode", value);
  const search = panel.getByRole("textbox", { name: "Search controls" });
  const expand = () =>
    panel
      .getByRole("button", { name: "Open full controls", exact: true })
      .click();
  const collapse = () =>
    page.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
  const definition = () =>
    panel.getByRole("button", { name: "level", exact: true }).click();
  const toggleGroup = (file) =>
    panel
      .getByRole("button", { name: `Toggle ${file} group`, exact: true })
      .click();
  await page.getByLabel("Strudel code editor").waitFor();
  await panel
    .getByRole("spinbutton", { name: "level knob", exact: true })
    .waitFor();
  await expect
    .poll(async () =>
      fs
        .readFile(path.join(root, ".wien-controls.json"), "utf8")
        .catch(() => ""),
    )
    .not.toBe("");
  await page.evaluate(async () => {
    const project = await window.workspace.current();
    await window.workspace.readControlPreferences(project.root);
  });
  await page.evaluate(
    (projectRoot) =>
      localStorage.setItem(
        `wien:controls:${projectRoot}`,
        JSON.stringify({
          pinned: null,
          roots: { "main.strudel": { hidden: {}, collapsed: {} } },
        }),
      ),
    settingsRoot,
  );
  await fs.unlink(path.join(root, ".wien-controls.json"));
  await page.reload();
  await expect
    .poll(async () => {
      try {
        return JSON.parse(
          await fs.readFile(path.join(root, ".wien-controls.json"), "utf8"),
        ).roots["main.strudel"];
      } catch {
        return undefined;
      }
    })
    .toEqual({ hidden: {}, collapsed: {} });
  await expect
    .poll(() =>
      page.evaluate(
        (projectRoot) => localStorage.getItem(`wien:controls:${projectRoot}`),
        settingsRoot,
      ),
    )
    .toBe(null);
  await panel
    .getByRole("button", { name: "Pin as master", exact: true })
    .click();
  await page.getByRole("button", { name: /^Play/ }).click();
  await expect(
    page.getByRole("button", { name: "Stop playback" }),
  ).toBeEnabled();
  await search.fill("level");
  await expand();
  await mode("fullscreen");
  await expect(search).toHaveValue("level");
  await expect(
    panel.getByRole("spinbutton", { name: "level knob" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Ask Assist", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+," : "Control+,",
  );
  await expect(
    page.getByRole("dialog", { name: "Wien assistant" }),
  ).toHaveCount(0);
  await definition();
  await mode("sidebar");
  await expect(
    page.getByRole("tab", { name: "lib/shared.strudel", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    panel.getByRole("button", { name: "Unpin master", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Back to controls", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Strudel code editor").filter({ visible: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Close lib/shared.strudel", exact: true })
    .click();
  await mode("fullscreen");
  await expect(search).toHaveValue("level");
  await expect(
    page.getByRole("button", { name: "Stop playback" }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: /^Update/ })).toBeVisible();
  await panel
    .getByRole("spinbutton", { name: "level knob" })
    .last()
    .press("ArrowUp");
  await page.waitForFunction(() =>
    window
      .getPattern()
      .queryArc(0, 1)
      .every((hap) => hap.value.gain === 0.21),
  );
  await page.getByRole("button", { name: "Stop playback" }).click();
  await search.fill("");
  await toggleGroup("lib/a.strudel");
  await expect(
    panel.getByRole("spinbutton", { name: "level knob", exact: true }),
  ).toHaveCount(1);
  await expect(
    panel.getByRole("region", {
      name: "lib/shared.strudel controls",
      exact: true,
    }),
  ).toHaveCount(1);
  assert.equal(
    await panel
      .getByRole("region")
      .evaluateAll((cards) =>
        cards.every((card) => !card.parentElement?.closest("section")),
      ),
    true,
  );

  await expect(
    panel.getByRole("button", {
      name: "Toggle lib/a.strudel group",
      exact: true,
    }),
  ).toHaveAttribute("aria-expanded", "false");
  await collapse();
  await mode("sidebar");
  await expect(
    panel.getByRole("button", {
      name: "Toggle lib/a.strudel group",
      exact: true,
    }),
  ).toHaveAttribute("aria-expanded", "false");
  await expand();
  await toggleGroup("lib/a.strudel");
  await expect(
    panel.getByRole("alert").filter({ hasText: "broken" }),
  ).toHaveCount(1);
  // External changes update the same live sources in both panel modes.
  await fs.writeFile(
    path.join(root, "lib/shared.strudel"),
    shared.replace("0.2", "0.6"),
  );
  await expect(panel.getByLabel("level value", { exact: true })).toHaveText(
    "0.6",
  );
  await fs.writeFile(
    path.join(root, "lib/shared.strudel"),
    "const level = 'changed'; export default note('c3')",
  );
  await panel
    .getByRole("spinbutton", { name: "level knob", exact: true })
    .press("ArrowUp");
  await expect(
    panel.getByRole("alert").filter({ hasText: "This control has changed" }),
  ).toHaveCount(1);
  assert.match(
    await fs.readFile(path.join(root, "lib/shared.strudel"), "utf8"),
    /level = 'changed'/,
  );

  await expect(
    panel.getByRole("spinbutton", { name: "level knob" }),
  ).toHaveCount(0);
  await fs.writeFile(path.join(root, "lib/shared.strudel"), shared);
  await expect(
    panel.getByRole("spinbutton", { name: "level knob" }),
  ).toHaveCount(1);
  // An already-open target returns to full controls without closing that tab.
  await definition();
  await expand();
  await expect(
    page.getByRole("button", {
      name: /^Play/,
    }),
  ).toBeVisible();
  await definition();
  await page
    .getByRole("button", { name: "Back to controls", exact: true })
    .click();
  await mode("fullscreen");
  await expect(
    page.getByRole("tab", { name: "lib/shared.strudel", exact: true }),
  ).toHaveCount(1);
  // Unpin follows the active editor in fullscreen too, rather than freezing an old root.
  await panel
    .getByRole("button", { name: "Unpin master", exact: true })
    .click();
  await expect(panel.locator('[class*="rootHeading"]')).toHaveText(
    "shared.strudel",
  );
  await page.getByRole("tab", { name: "main.strudel", exact: true }).click();
  await panel
    .getByRole("button", { name: "Pin as master", exact: true })
    .click();
  await expand();
  await page.getByRole("button", { name: "main.strudel", exact: true }).click();
  await mode("sidebar");
  await expand();
  // A file error does not hide subsequent healthy imports.
  await collapse();
  await panel
    .getByRole("button", { name: "Unpin master", exact: true })
    .click();
  await page
    .getByRole("button", { name: "missing-master.strudel", exact: true })
    .click();
  await expect(
    panel.getByRole("spinbutton", { name: "lateAmount knob" }),
  ).toHaveCount(1);
  await expand();
  await expect(
    panel.getByRole("spinbutton", { name: "lateAmount knob" }),
  ).toHaveCount(1);
  await expect(
    panel.getByRole("alert").filter({ hasText: "missing.strudel" }),
  ).toHaveCount(1);
  await fs.writeFile(
    path.join(root, "lib/missing.strudel"),
    "const recovered = 0.1; export default note('c3')",
  );
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(
    panel.getByRole("spinbutton", { name: "recovered knob" }),
  ).toHaveCount(1);
  // A failed current-file save has the same local diagnostic as an imported one.
  await fs.appendFile(
    path.join(root, "missing-master.strudel"),
    "\n// external change",
  );
  await panel
    .getByRole("spinbutton", { name: "rootAmount knob" })
    .press("ArrowUp");
  await expect(
    panel.getByRole("alert").filter({ hasText: "changed on disk" }),
  ).toHaveCount(1);
  await panel
    .getByRole("spinbutton", { name: "lateAmount knob" })
    .press("ArrowUp");
  await expect
    .poll(() => fs.readFile(path.join(root, "lib/late.strudel"), "utf8"))
    .toContain("lateAmount = 1.7");
  await panel
    .getByRole("button", { name: "Reload source…", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Discard and reload", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await panel
    .getByRole("button", { name: "Pin as master", exact: true })
    .click();
  await toggleGroup("lib/late.strudel");
  await page
    .getByRole("button", { name: "missing-master.strudel", exact: true })
    .click({ button: "right" });
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("renamed.strudel");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  await expect(panel.locator('[class*="rootHeading"]')).toHaveText(
    "renamed.strudel",
  );
  await expect(
    panel.getByRole("button", {
      name: "Toggle lib/late.strudel group",
      exact: true,
    }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(
      async () =>
        JSON.parse(
          await fs.readFile(path.join(root, ".wien-controls.json"), "utf8"),
        ).pinned,
    )
    .toBe("renamed.strudel");
  const tabs = await page
    .getByRole("tablist")
    .getByRole("tab")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute("aria-label"))
        .filter((name) => name !== "Controls view"),
    );
  for (const tab of tabs)
    await page
      .getByRole("button", { name: `Close ${tab}`, exact: true })
      .click();
  await mode("fullscreen");
  await panel
    .getByRole("spinbutton", { name: "rootAmount knob" })
    .press("ArrowUp");
  await expect
    .poll(() => fs.readFile(path.join(root, "renamed.strudel"), "utf8"))
    .toContain("rootAmount = 1.4");
  await collapse();
  await expand();
  await mode("fullscreen");
  await expect(
    page.getByRole("button", { name: "Exit fullscreen", exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "rootAmount", exact: true }).click();
  await mode("sidebar");
  await page
    .getByRole("button", { name: "Close renamed.strudel", exact: true })
    .click();
  await mode("fullscreen");
  await expect(
    page.getByLabel("Strudel code editor").filter({ visible: true }),
  ).toHaveCount(0);
  const positions = await panel.getByRole("region").evaluateAll((cards) =>
    cards.map((card) => ({
      x: card.getBoundingClientRect().x,
      y: card.getBoundingClientRect().y,
    })),
  );
  assert(
    new Set(positions.map(({ x }) => x)).size > 1,
    "Independent cards should use the available columns",
  );
  await page.screenshot({ path: path.join(temporary, "full-controls.png") });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: independent cards across modes, pinned roots, search/state, source round trips, errors/recovery, refresh, rename persistence, toolbar and controls without editor tabs.",
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(temporary, "failure.png") })
      .catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  console.log("Panel mode artifacts:", temporary);
}
