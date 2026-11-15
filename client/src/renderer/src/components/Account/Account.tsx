import { Loader2, UserRound } from "lucide-react";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { UserProfile } from "../../../../shared/account";
import { paymentId } from "../../../../shared/payments";
import { formatLocale, getLocale, t, useLocale } from "../../i18n";
import { Dialog } from "../Dialog/Dialog";
import {
  type BillingTab,
  SubscriptionPlans,
} from "../SubscriptionPlans/SubscriptionPlans";
import styles from "./Account.module.css";
import { Turnstile } from "./Turnstile";

const api = window.workspace;
const registrationRequested =
  api.platform === "web" &&
  new URLSearchParams(window.location.search).has("register");
const paymentQuery =
  api.platform === "web"
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams();
const returnOrderId = (() => {
  const value = paymentQuery.get("payment");
  try {
    return value ? paymentId(value) : undefined;
  } catch {
    return undefined;
  }
})();
const paymentReturned =
  paymentQuery.has("payment") || paymentQuery.has("billing");
const initialBillingTab: BillingTab = (() => {
  if (paymentQuery.has("payment")) return "payments";
  const tab = paymentQuery.get("billing");
  if (tab === "plans" || tab === "offer" || tab === "privacy") return tab;
  // Preserve Robokassa's /?billing=1 return link.
  return paymentReturned ? "payments" : "plans";
})();
const errorMessage = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );

interface AccountContextValue {
  user: UserProfile | null;
  resolved: boolean;
  dialogOpen: boolean;
  refresh: () => Promise<UserProfile | null>;
  openProfile: () => void;
  openUpgrade: (reason?: "audio") => void;
  openTerms: (tab?: "plans" | "offer" | "privacy") => void;
  ensureAssist: (audio?: boolean) => Promise<boolean>;
  assistBlocked: (action: "sign_in" | "upgrade") => void;
}
const AccountContext = createContext<AccountContextValue | null>(null);
export function useAccount() {
  const value = useContext(AccountContext);
  if (!value) throw new Error("AccountProvider is missing.");
  return value;
}

export function AccountProvider({ children }: { children: ReactNode }) {
  useLocale();
  const [open, setOpen] = useState(registrationRequested);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [resolved, setResolved] = useState(false);
  const [mode, setMode] = useState<"login" | "register" | "password">(
    registrationRequested ? "register" : "login",
  );
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaAttempt, setCaptchaAttempt] = useState(0);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [plansOpen, setPlansOpen] = useState(paymentReturned);
  const [plansTab, setPlansTab] = useState<BillingTab>(initialBillingTab);
  const [upgradeReason, setUpgradeReason] = useState<"audio">();
  const resumePayment = useRef(false);
  const refreshVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const profile = await api.accountCurrent();
    if (version === refreshVersion.current) {
      setUser(profile);
      setResolved(true);
    }
    return profile;
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
    return () => {
      refreshVersion.current++;
    };
  }, [refresh]);

  function openProfile() {
    setPlansOpen(false);
    setOpen(true);
  }
  function openUpgrade(reason?: "audio") {
    close();
    setPlansTab("plans");
    setUpgradeReason(reason);
    setPlansOpen(true);
  }
  function openTerms(tab: "plans" | "offer" | "privacy" = "plans") {
    setPlansTab(tab);
    setUpgradeReason(undefined);
    setPlansOpen(true);
  }
  function assistBlocked(action: "sign_in" | "upgrade") {
    if (action === "sign_in") {
      refreshVersion.current++;
      setUser(null);
      setResolved(true);
      close();
      openProfile();
      setNotice("Sign in to use Assist.");
    } else {
      openUpgrade();
    }
  }
  async function ensureAssist(audio = false) {
    const profile = await refresh();
    if (!profile) {
      assistBlocked("sign_in");
      return false;
    }
    if (audio && !profile.plan.audio_enabled) {
      throw new Error(t("Audio attachments are not included in your plan."));
    }
    if (
      profile.plan.initial_assist_requests !== null &&
      profile.assist_requests_remaining <= 0
    ) {
      assistBlocked("upgrade");
      return false;
    }
    return true;
  }

  function clearPasswords() {
    setCaptchaToken("");
    setPassword("");
    setNextPassword("");
    setConfirmation("");
  }
  function close() {
    resumePayment.current = false;
    setOpen(false);
    clearPasswords();
    setError("");
    setNotice("");
    setMode("login");
  }
  function switchMode() {
    setMode(mode === "register" ? "login" : "register");
    clearPasswords();
    setError("");
    setNotice("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (
      (mode === "register" && password !== confirmation) ||
      (mode === "password" && nextPassword !== confirmation)
    ) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "register" && (!api.accountRegister || !captchaToken)) {
        throw new Error(
          t("Complete the verification before creating an account."),
        );
      }
      const profile =
        mode === "password"
          ? await api.accountChangePassword({
              current_password: password,
              new_password: nextPassword,
            })
          : mode === "register" && api.accountRegister
            ? await api.accountRegister({
                username,
                password,
                turnstile_token: captchaToken,
              })
            : await api.accountLogin({ username, password });
      refreshVersion.current++;
      setUser(profile);
      setResolved(true);
      if (resumePayment.current) {
        resumePayment.current = false;
        setOpen(false);
        setPlansTab("payments");
        setPlansOpen(true);
      }
      clearPasswords();
      setNotice(
        mode === "password"
          ? "Password changed. Other sessions have been signed out."
          : "",
      );
      setMode("login");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      if (mode === "register") {
        setCaptchaToken("");
        setCaptchaAttempt((value) => value + 1);
      }
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.accountLogout();
      refreshVersion.current++;
      setUser(null);
      setResolved(true);
      clearPasswords();
      setMode("login");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AccountContext.Provider
      value={{
        user,
        resolved,
        dialogOpen: open || plansOpen,
        refresh,
        openProfile,
        openUpgrade,
        openTerms,
        ensureAssist,
        assistBlocked,
      }}
    >
      {children}
      {plansOpen && (
        <SubscriptionPlans
          exhausted={
            !!user &&
            user.plan.initial_assist_requests !== null &&
            user.assist_requests_remaining === 0
          }
          initialTab={plansTab}
          audio={upgradeReason === "audio"}
          currentPlanId={user?.plan.id}
          userId={user?.id}
          returnOrderId={returnOrderId}
          onPaid={refresh}
          onSignIn={() => {
            resumePayment.current = true;
            openProfile();
          }}
          onClose={() => setPlansOpen(false)}
        />
      )}
      {open && (
        <Dialog
          title={
            user
              ? t("Your profile")
              : mode === "register"
                ? t("Create an account")
                : t("Sign in")
          }
          onClose={close}
        >
          <div className={styles.content}>
            {user && (
              <div className={styles.profile}>
                <UserRound size={28} />
                <strong>@{user.username}</strong>
                <span className={styles.tier}>
                  {getLocale() === "ru"
                    ? user.plan.name_ru || user.plan.name
                    : user.plan.name}
                </span>
                {user.subscription_expires_at && (
                  <span>
                    {t("Действует до")}{" "}
                    {new Date(user.subscription_expires_at).toLocaleString(
                      formatLocale(),
                    )}
                  </span>
                )}
                <span>
                  {t("Joined")}{" "}
                  {new Date(user.created_at).toLocaleDateString(formatLocale())}
                </span>
              </div>
            )}
            {(!user || mode === "password") && (
              <form
                onSubmit={(event) => {
                  void submit(event);
                }}
              >
                <fieldset disabled={busy}>
                  {!user && (
                    <label htmlFor="account-username">
                      {t("Username")}
                      <input
                        id="account-username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        autoComplete="username"
                        autoCapitalize="none"
                        spellCheck={false}
                        pattern="[a-z0-9_]{3,32}"
                        minLength={3}
                        maxLength={32}
                        required
                      />
                    </label>
                  )}
                  {!user && mode === "register" && (
                    <p>{t("3–32 lowercase letters, digits or underscores.")}</p>
                  )}
                  <label htmlFor="account-password">
                    {user ? t("Current password") : t("Password")}
                    <input
                      id="account-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete={
                        mode === "register"
                          ? "new-password"
                          : "current-password"
                      }
                      minLength={12}
                      maxLength={256}
                      required
                    />
                  </label>
                  {mode === "password" && (
                    <label htmlFor="account-new-password">
                      {t("New password")}
                      <input
                        id="account-new-password"
                        type="password"
                        value={nextPassword}
                        onChange={(e) => setNextPassword(e.target.value)}
                        autoComplete="new-password"
                        minLength={12}
                        maxLength={256}
                        required
                      />
                    </label>
                  )}
                  {(mode === "register" || mode === "password") && (
                    <>
                      <label htmlFor="account-confirmation">
                        {t("Confirm password")}
                        <input
                          id="account-confirmation"
                          type="password"
                          value={confirmation}
                          onChange={(e) => setConfirmation(e.target.value)}
                          autoComplete="new-password"
                          minLength={12}
                          maxLength={256}
                          required
                        />
                      </label>
                      <p>{t("12–128 characters.")}</p>
                    </>
                  )}
                  {mode === "register" && (
                    <p>
                      {t("Как мы обрабатываем данные:")}{" "}
                      <button
                        type="button"
                        onClick={() => openTerms("privacy")}
                      >
                        {t("политика конфиденциальности")}
                      </button>
                      .
                    </p>
                  )}
                  {mode === "register" && api.platform === "web" && (
                    <Turnstile key={captchaAttempt} onToken={setCaptchaToken} />
                  )}
                  <button
                    className={styles.primary}
                    type="submit"
                    disabled={mode === "register" && !captchaToken}
                  >
                    {busy && <Loader2 className={styles.spinner} size={14} />}{" "}
                    {mode === "register"
                      ? t("Create account")
                      : mode === "password"
                        ? t("Change password")
                        : t("Sign in")}
                  </button>
                </fieldset>
              </form>
            )}
            {error && (
              <p className={styles.error} role="alert">
                {t(error)}
              </p>
            )}
            {notice && <p role="status">{t(notice)}</p>}
            <div className={styles.actions}>
              {!user && api.platform === "web" && (
                <button type="button" disabled={busy} onClick={switchMode}>
                  {mode === "register"
                    ? t("Already have an account? Sign in")
                    : t("Create an account")}
                </button>
              )}
              {!user && api.platform !== "web" && (
                <button
                  type="button"
                  onClick={() => {
                    void api.openExternalLink(
                      "https://wien.aydar.media/?register",
                    );
                  }}
                >
                  {t("Create an account on the website")}
                </button>
              )}
              {user && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setMode(mode === "password" ? "login" : "password");
                      clearPasswords();
                      setError("");
                      setNotice("");
                    }}
                  >
                    {mode === "password" ? t("Cancel") : t("Change password")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void logout();
                    }}
                  >
                    {t("Sign out")}
                  </button>
                </>
              )}
            </div>
          </div>
        </Dialog>
      )}
    </AccountContext.Provider>
  );
}
