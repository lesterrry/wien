import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-banks-"));
const environment = { ...process.env, WIEN_USER_DATA: temporary };
delete environment.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    args: ["--mute-audio", "out/main/index.js"],
    env: environment,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const diagnostics = [];
  const lateLoads = [];
  const loaded = new Set();
  page.on("console", (event) => {
    if (/loading sound .* took too long/.test(event.text())) {
      lateLoads.push(event.text());
    } else if (
      event.type() === "error" ||
      /not found|could not load/i.test(event.text())
    ) {
      diagnostics.push(event.text().slice(0, 400));
    }
  });
  page.on("requestfailed", (request) =>
    diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`),
  );
  page.on("response", (response) => {
    if (
      response.ok() &&
      response.url().includes("/tidal-drum-machines/machines/")
    )
      loaded.add(response.url());
    if (response.status() >= 400)
      diagnostics.push(`${response.status()} ${response.url()}`);
  });
  const code = page.getByLabel("Strudel code editor", { exact: true });
  await code.waitFor();
  assert.equal(
    loaded.size,
    0,
    "Bank metadata must not download audio on startup",
  );
  for (const bank of ["tr909", "RolandTR909", "tr808"]) {
    await code.click();
    await code.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await page.keyboard.insertText(
      `setcpm(120)\n$: s("[bd <hh oh>]*2").bank("${bank}").dec(.4)`,
    );
    await page.getByRole("button", { name: /^(Play|Update)/ }).click();
    await expect(
      page.getByRole("button", { name: "Stop playback", exact: true }),
    ).toBeEnabled();
    await page.evaluate(() => {
      if (window.__bankMeter) return;
      const meter = window.getAudioContext().createAnalyser();
      window
        .getSuperdoughAudioController()
        .output.destinationGain.connect(meter);
      window.__bankMeter = meter;
    });
    const peak = () =>
      page.evaluate(async () => {
        let peak = 0;
        const meter = window.__bankMeter;
        const samples = new Float32Array(meter.fftSize);
        for (let index = 0; index < 25; index++) {
          meter.getFloatTimeDomainData(samples);
          for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        return peak;
      });
    try {
      await expect.poll(peak, { timeout: 30000 }).toBeGreaterThan(0.001);
    } catch (error) {
      console.log("Bank diagnostics:", diagnostics);
      throw error;
    }
    const machine = bank === "tr808" ? "RolandTR808" : "RolandTR909";
    await expect
      .poll(() =>
        ["bd", "hh", "oh"].every((sound) =>
          [...loaded].some(
            (url) =>
              url.includes(`/${machine}/`) &&
              url.toLowerCase().includes(`-${sound}/`),
          ),
        ),
      )
      .toBe(true);
    console.log(bank, "audio peak:", await peak());
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await expect.poll(peak).toBeLessThan(0.001);
  }
  console.log(
    "Cold sample loads that missed their first scheduled hit:",
    lateLoads.length,
  );
  assert.deepEqual(diagnostics, []);
  console.log("PASS: Roland TR909, tr909 and tr808 banks produce real audio.");
} finally {
  if (app) await app.close();
  console.log("Bank artifacts:", temporary);
}
