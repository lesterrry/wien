export const onboardingSeenKey = "wien:onboarding-seen";

export function hasSeenOnboarding() {
  try {
    return localStorage.getItem(onboardingSeenKey) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingSeen() {
  try {
    localStorage.setItem(onboardingSeenKey, "1");
  } catch {
    // Private/restricted storage must not prevent exploring the app.
  }
}
