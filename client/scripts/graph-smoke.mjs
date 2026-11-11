import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-graph-"));
const environment = { ...process.env, WIEN_USER_DATA: temporary };
delete environment.ELECTRON_RUN_AS_NODE;
const mod = process.platform === "darwin" ? "Meta" : "Control";
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
  const code = page.getByLabel("Strudel code editor", { exact: true });
  const graph = page.getByRole("region", { name: "Project dependency graph" });
  const graphTab = page.getByRole("tab", { name: "Graph View", exact: true });
  const node = (id) =>
    graph.locator(`.react-flow__node[data-id=${JSON.stringify(id)}]`);
  const rim = (id) => node(id).locator("span[aria-hidden=true]").first();
  const animation = (id) =>
    rim(id).evaluate(
      (element) => getComputedStyle(element, "::before").animationPlayState,
    );
  const project = path.join(temporary, "projects/First session");
  await code.waitFor();
  await page
    .getByRole("button", { name: "first-light.strudel", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "first-light.strudel", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: /^Play/ }).click();
  await expect(
    page.getByRole("tab", { name: "first-light.strudel", exact: true }),
  ).toHaveAttribute("aria-description", "Playing");
  await page
    .getByRole("button", { name: "Open Graph View", exact: true })
    .click();
  await expect(graphTab).toHaveAttribute("aria-selected", "true");
  await expect(graph).toHaveAttribute("aria-busy", "false");
  await expect(graph.locator(".react-flow__node")).toHaveCount(5);
  await expect(graph.locator(".react-flow__edge")).toHaveCount(1);
  await expect(graph.locator(".react-flow__edge")).toHaveAttribute(
    "aria-label",
    "instruments/glass.strudel is used by first-light.strudel",
  );
  await expect(graph.locator(".react-flow__edge-path")).toHaveAttribute(
    "marker-end",
    /url\(/,
  );
  await expect(node("sketches/low-tide.strudel")).toBeVisible();
  // Only a snippet's own player lights its node, not its imported dependencies.
  await expect.poll(() => animation("first-light.strudel")).toBe("running");
  await expect(rim("first-light.strudel")).toHaveCSS("opacity", "0.9");
  await expect
    .poll(() => animation("instruments/glass.strudel"))
    .toBe("paused");
  await expect(rim("instruments/glass.strudel")).toHaveCSS("opacity", "0");
  await expect(rim("sketches/low-tide.strudel")).toHaveCSS("opacity", "0");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      rim("first-light.strudel").evaluate(
        (element) => getComputedStyle(element, "::before").animationName,
      ),
    )
    .toBe("none");
  await expect(rim("first-light.strudel")).toHaveCSS("opacity", "0.9");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect
    .poll(async () => {
      const bounds = await graph.locator(".react-flow").boundingBox();
      const boxes = await graph
        .locator(".react-flow__node")
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const { x, y, width, height } = node.getBoundingClientRect();
            return { x, y, width, height };
          }),
        );
      const centerX =
        (Math.min(...boxes.map((box) => box.x)) +
          Math.max(...boxes.map((box) => box.x + box.width))) /
        2;
      const centerY =
        (Math.min(...boxes.map((box) => box.y)) +
          Math.max(...boxes.map((box) => box.y + box.height))) /
        2;
      return (
        Math.abs(centerX - bounds.x - bounds.width / 2) < 2 &&
        Math.abs(centerY - bounds.y - bounds.height / 2) < 2 &&
        boxes.every(
          (box) =>
            box.x >= bounds.x &&
            box.y >= bounds.y &&
            box.x + box.width <= bounds.x + bounds.width &&
            box.y + box.height <= bounds.y + bounds.height,
        )
      );
    })
    .toBe(true);
  await page.screenshot({ path: path.join(temporary, "overview.png") });

  // Graph is a persistent tab, not a modal; its camera survives tab switching.
  await graph.getByRole("button", { name: /zoom in/i }).click();
  await page.waitForTimeout(350);
  const viewport = await graph
    .locator(".react-flow__viewport")
    .getAttribute("style");
  await page
    .getByRole("tab", { name: "first-light.strudel", exact: true })
    .click();
  await graphTab.click();
  await expect(graph).toHaveAttribute("aria-busy", "false");
  assert.equal(
    await graph.locator(".react-flow__viewport").getAttribute("style"),
    viewport,
  );
  await expect(graphTab).toHaveCount(1);
  const positions = () =>
    graph
      .locator(".react-flow__node")
      .evaluateAll((nodes) => nodes.map((node) => node.style.transform));
  const beforeStop = await positions();
  await page.keyboard.press(`${mod}+.`);
  await expect.poll(() => animation("first-light.strudel")).toBe("paused");
  await expect(rim("first-light.strudel")).toHaveCSS("opacity", "0");
  assert.deepEqual(await positions(), beforeStop);
  assert.equal(
    await graph.locator(".react-flow__viewport").getAttribute("style"),
    viewport,
  );
  await page
    .getByRole("tab", { name: "first-light.strudel", exact: true })
    .click();
  await page.getByRole("button", { name: /^Play/ }).click();
  await graphTab.click();
  await expect.poll(() => animation("first-light.strudel")).toBe("running");
  await expect(rim("first-light.strudel")).toHaveCSS("opacity", "0.9");
  await page
    .getByRole("tab", { name: "first-light.strudel", exact: true })
    .click();
  await page.getByRole("button", { name: "Snippet actions" }).click();
  await page
    .getByRole("button", { name: "View in Graph View", exact: true })
    .click();
  await expect(node("first-light.strudel")).toHaveClass(/selected/);
  await expect
    .poll(async () => {
      const bounds = await graph.locator(".react-flow").boundingBox();
      const box = await node("first-light.strudel").boundingBox();
      return (
        Math.abs(box.x + box.width / 2 - bounds.x - bounds.width / 2) +
        Math.abs(box.y + box.height / 2 - bounds.y - bounds.height / 2)
      );
    })
    .toBeLessThan(2);
  await page.screenshot({ path: path.join(temporary, "focused.png") });

  // Opening a graph node preserves background playback and returns to its editor.
  await node("instruments/glass.strudel").dblclick();
  await expect(
    page.getByRole("tab", { name: "instruments/glass.strudel", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(code).toContainText("export default");
  await expect(
    page.getByRole("tab", { name: "first-light.strudel", exact: true }),
  ).toHaveAttribute("aria-description", "Playing");
  await page.getByRole("button", { name: "Snippet actions" }).click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("bell.strudel");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await graphTab.click();
  await expect(node("instruments/bell.strudel")).toHaveCount(1);
  await expect(node("instruments/glass.strudel")).toHaveCount(0);
  await expect(graph.locator(".react-flow__edge")).toHaveAttribute(
    "aria-label",
    "instruments/bell.strudel is used by first-light.strudel",
  );

  // External files, isolated nodes and broken imports all remain inspectable.
  await fs.writeFile(
    path.join(project, "unused.js"),
    'globalThis.__graphExecuted = true; throw new Error("Must not execute")',
  );
  await fs.writeFile(path.join(project, "broken.js"), 'import "./missing.js";');
  await graph.getByRole("button", { name: "Refresh graph" }).click();
  await expect(graph.locator(".react-flow__node")).toHaveCount(7);
  await expect(graph).toContainText("1 snippet with dependency issues");
  await graph.getByRole("button", { name: "Fit all snippets" }).click();
  await node("broken.js").click();
  await expect(graph).toContainText("Missing snippet: ./missing.js");
  assert.equal(await page.evaluate(() => window.__graphExecuted), undefined);
  await fs.unlink(path.join(project, "unused.js"));
  await graph.getByRole("button", { name: "Refresh graph" }).click();
  await expect(graph.locator(".react-flow__node")).toHaveCount(6);

  // Cmd+W closes the graph only, keeping snippet tabs and their playback intact.
  await page.keyboard.press(`${mod}+w`);
  await expect(graphTab).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "instruments/bell.strudel", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tab", { name: "first-light.strudel", exact: true }),
  ).toHaveAttribute("aria-description", "Playing");
  await page.keyboard.press(`${mod}+Shift+.`);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: graph tab, all nodes and imports, isolated files, fit/zoom/focus, viewport persistence, node navigation, rename, refresh, parse-only errors, background playback, live playing borders and reduced motion.",
  );
} finally {
  if (app) {
    try {
      await app.close();
    } catch {
      app.process().kill("SIGKILL");
    }
  }
  console.log("Graph artifacts:", temporary);
}
