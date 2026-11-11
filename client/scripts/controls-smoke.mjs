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
  const repeated = b.getByRole("button", { name: /shared.strudel/ });
  await expect(repeated).toHaveAttribute("aria-expanded", "false");
  await repeated.click();
  await expect(
    panel.getByRole("spinbutton", { name: "level knob" }),
  ).toHaveCount(2);
  await panel
    .getByRole("spinbutton", { name: "level knob" })
    .first()
    .press("ArrowUp");
  await expect(panel.getByLabel("level value")).toHaveText(["0.41", "0.41"]);
  await expect
    .poll(() => fs.readFile(path.join(projectRoot, "shared.strudel"), "utf8"))
    .toContain("level = 0.41");
  await page.getByRole("button", { name: /^Play/ }).click();
  await page.getByText("Playing", { exact: true }).waitFor();
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
  await repeated.click();
  await search.fill("level");
  await expect(
    panel.getByRole("spinbutton", { name: "gain knob" }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("spinbutton", { name: "level knob" }),
  ).toHaveCount(2);
  await search.fill("");
  await expect(repeated).toHaveAttribute("aria-expanded", "false");
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
  await expect(repeated).toHaveAttribute("aria-expanded", "false");
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
  await page.screenshot({ path: path.join(temporary, "grouped-controls.png") });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: recursive groups, shared values, pinned navigation, source selection, live master updates, uninterrupted transport, search, hide/restore, persistence and isolated errors.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  console.log("Test artifacts:", temporary);
}
