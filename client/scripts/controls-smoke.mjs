import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-groups-"));
const projectRoot = path.join(temporary, "project");
await fs.mkdir(projectRoot);
const sources = {
  "master.strudel":
    "import a from './a.strudel';\nimport b from './b.strudel';\nconst gain = 0.5;\nstack(a, b)",
  "a.strudel":
    "import shared from './shared.strudel';\nconst gain = 0.2;\nexport default shared.pan(-0.5)",
  "b.strudel":
    "import shared from './shared.strudel';\nconst gain = 0.3;\nexport default shared.pan(0.5)",
  "shared.strudel":
    "const enabled = true;\nconst level = 0.4;\nexport default note('c3*4').s('sine').gain(enabled ? level : 0)",
};
for (const [file, code] of Object.entries(sources))
  await fs.writeFile(path.join(projectRoot, file), code);
const environment = {
  ...process.env,
  WIEN_USER_DATA: path.join(temporary, "state"),
  WIEN_PROJECT: projectRoot,
};
delete environment.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    args: ["--mute-audio", "out/main/index.js"],
    env: environment,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByLabel("Strudel code editor").waitFor();
  // Open master explicitly: project discovery sorts file names.
  await page
    .getByRole("button", { name: "master.strudel", exact: true })
    .click();
  const panel = page.getByRole("complementary", { name: "Snippet controls" });
  const search = panel.getByRole("textbox", { name: "Search controls" });
  await panel.getByRole("button", { name: "Pin as master" }).click();
  await expect(
    panel.getByRole("spinbutton", { name: "gain knob" }),
  ).toHaveCount(3);
  await expect(
    panel.getByRole("spinbutton", { name: "level knob" }),
  ).toHaveCount(1);
  const b = panel.getByRole("region", {
    name: "b.strudel controls",
    exact: true,
  });
  const shared = panel.getByRole("region", {
    name: "shared.strudel controls",
    exact: true,
  });
  const sharedHeading = shared.getByRole("button", {
    name: "Toggle shared.strudel group",
    exact: true,
  });
  await expect(shared).toHaveCount(1);
  await expect(b.getByRole("region")).toHaveCount(0);
  const aHeading = panel.getByRole("button", {
    name: "Toggle a.strudel group",
    exact: true,
  });
  await aHeading.click();
  await expect(
    panel.getByRole("spinbutton", { name: "level knob" }),
  ).toHaveCount(1);
  await aHeading.click();
  await panel
    .getByRole("spinbutton", { name: "level knob" })
    .first()
    .press("ArrowUp");
  await expect(panel.getByLabel("level value")).toHaveText("0.41");
  await expect
    .poll(() => fs.readFile(path.join(projectRoot, "shared.strudel"), "utf8"))
    .toContain("level = 0.41");
  await page.getByRole("button", { name: /^Play/ }).click();
  await expect(
    page.getByRole("button", { name: "Stop playback" }),
  ).toBeEnabled();
  await page.waitForFunction(() =>
    window
      .getPattern()
      .queryArc(0, 1)
      .every((hap) => hap.value.gain === 0.41),
  );
  const patternTime = await page.evaluate(() => window.getTime());
  await panel
    .getByRole("spinbutton", { name: "level knob" })
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Go to declaration" }).click();
  await expect(
    page.getByRole("tab", { name: "shared.strudel", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("button", { name: "Unpin master" })).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("button", { name: "Stop playback" }),
  ).toBeEnabled();
  const selected = await page
    .getByLabel("Strudel code editor")
    .filter({ visible: true })
    .evaluate(() => window.getSelection()?.toString());
  assert.equal(selected, "0.41");
  await panel
    .getByRole("spinbutton", { name: "level knob" })
    .last()
    .press("ArrowUp");
  await page.waitForFunction(() =>
    window
      .getPattern()
      .queryArc(0, 1)
      .every((hap) => hap.value.gain === 0.42),
  );
  assert(
    (await page.evaluate(() => window.getTime())) >= patternTime,
    "Updating a dependency must not reset the transport",
  );
  await page
    .getByRole("button", { name: "Close shared.strudel", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "master.strudel", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "Stop playback" }),
  ).toBeEnabled();
  await sharedHeading.click();
  await search.fill("level");
  await expect(
    panel.getByRole("spinbutton", { name: "gain knob" }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("spinbutton", { name: "level knob" }),
  ).toHaveCount(1);
  await search.fill("");
  await expect(sharedHeading).toHaveAttribute("aria-expanded", "false");
  const a = panel.getByRole("region", {
    name: "a.strudel controls",
    exact: true,
  });
  await a
    .getByRole("button", { name: "Toggle a.strudel group", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide group" }).click();
  await expect(a).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Hidden groups (1)" }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Stop playback" }).click();
  await page.reload();
  await expect(panel.getByRole("button", { name: "Unpin master" })).toHaveCount(
    1,
  );
  await expect(a).toHaveCount(0);
  await expect(sharedHeading).toHaveAttribute("aria-expanded", "false");
  // Hiding is scoped to a root, even when that same file becomes a master.
  await panel.getByRole("button", { name: "Unpin master" }).click();
  await expect(
    panel.getByRole("button", { name: "Hidden groups (1)" }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("spinbutton", { name: "gain knob" }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "master.strudel", exact: true })
    .click();
  await panel.getByRole("button", { name: "Pin as master" }).click();
  await expect(a).toHaveCount(0);
  await panel.getByRole("button", { name: "Hidden groups (1)" }).click();
  await panel.getByRole("button", { name: /^Restore/ }).click();
  await expect(a).toHaveCount(1);
  await sharedHeading.click();
  // Semantic failure affects only its own declaration.
  await fs.appendFile(
    path.join(projectRoot, "shared.strudel"),
    "\nconst broken = 1 / 0;",
  );
  await page.getByRole("button", { name: "Refresh files" }).click();
  await expect(
    panel.getByRole("alert").filter({ hasText: "broken" }),
  ).toHaveCount(1);
  await expect(
    panel.getByRole("spinbutton", { name: "level knob" }),
  ).toHaveCount(1);
  await panel
    .getByRole("spinbutton", { name: "gain knob" })
    .first()
    .press("ArrowUp");
  await expect
    .poll(() => fs.readFile(path.join(projectRoot, "master.strudel"), "utf8"))
    .toContain("gain = 0.51");
  const enabledRow = panel
    .getByRole("group", { name: "enabled control", exact: true })
    .first();
  await enabledRow.focus();
  await enabledRow.press("Alt+ArrowDown");
  await expect
    .poll(async () => {
      const source = await fs.readFile(
        path.join(projectRoot, "shared.strudel"),
        "utf8",
      );
      return source.indexOf("const level") < source.indexOf("const enabled");
    })
    .toBe(true);
  await panel
    .getByRole("button", { name: "Open full controls", exact: true })
    .click();
  await expect(panel).toHaveAttribute("data-mode", "fullscreen");
  const geometry = await panel.getByRole("group").evaluateAll((rows) =>
    rows.map((row) => {
      const card = row.firstElementChild;
      const control = row.querySelector('[role="spinbutton"], [role="switch"]');
      const output = row.querySelector("output");
      const bounds = card.getBoundingClientRect();
      const button = control.getBoundingClientRect();
      return {
        width: bounds.width,
        height: bounds.height,
        valueY: output.getBoundingClientRect().top - bounds.top,
        centerY: button.top + button.height / 2 - bounds.top,
        extraLabel: Boolean(row.querySelector("small")),
      };
    }),
  );
  for (const property of ["width", "height", "valueY", "centerY"]) {
    const values = geometry.map((card) => card[property]);
    assert(
      Math.max(...values) - Math.min(...values) < 1,
      `Control cards must align: ${property}`,
    );
  }
  assert(
    geometry.every((card) => !card.extraLabel),
    "Duplicate names must not add a source label above the card",
  );
  await page.screenshot({ path: path.join(temporary, "uniform-controls.png") });

  await page
    .getByRole("spinbutton", { name: "level knob", exact: true })
    .press("ArrowUp");
  await expect
    .poll(() => fs.readFile(path.join(projectRoot, "shared.strudel"), "utf8"))
    .toContain("level = 0.43");
  await page
    .getByRole("button", { name: "Close controls", exact: true })
    .click();
  await expect(panel.getByLabel("level value", { exact: true })).toHaveText(
    "0.43",
  );
  await page.screenshot({ path: path.join(temporary, "grouped-controls.png") });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: independent file cards, recursive imports, shared values, pinned navigation, source selection, live master updates, uninterrupted transport, search, hide/restore, persistence and isolated errors.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  console.log("Test artifacts:", temporary);
}
