// Workspace regressions choose their language explicitly. The localization smoke
// keeps fresh storage and verifies the Russian default independently.
export async function skipOnboarding(page, locale = "en") {
  await page.waitForFunction(() => Boolean(window.workspace));
  await page.evaluate((language) => {
    localStorage.setItem("wien:onboarding-seen", "1");
    localStorage.setItem("wien:locale", language);
  }, locale);
  await page.reload();
}

export async function workspaceWindow(app) {
  const page = await app.firstWindow();
  await skipOnboarding(page);
  return page;
}
