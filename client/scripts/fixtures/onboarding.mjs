// Existing workspace regressions start as returning visitors. The dedicated
// onboarding smoke keeps fresh storage and checks the first-visit experience.
export async function skipOnboarding(page) {
  await page.waitForFunction(() => Boolean(window.workspace));
  await page.evaluate(() => localStorage.setItem("wien:onboarding-seen", "1"));
  await page.reload();
}

export async function workspaceWindow(app) {
  const page = await app.firstWindow();
  await skipOnboarding(page);
  return page;
}
