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
import { Dialog } from "../Dialog/Dialog";
import { SubscriptionPlans } from "../SubscriptionPlans/SubscriptionPlans";
import styles from "./Account.module.css";
import { Turnstile } from "./Turnstile";

const api = window.workspace;
const registrationRequested =
  api.platform === "web" &&
  new URLSearchParams(window.location.search).has("register");
const errorMessage = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );

interface AccountContextValue {
  user: UserProfile | null;
  refresh: () => Promise<UserProfile | null>;
  openProfile: () => void;
  openUpgrade: () => void;
  ensureAssist: () => Promise<boolean>;
  assistBlocked: (action: "sign_in" | "upgrade") => void;
}
const AccountContext = createContext<AccountContextValue | null>(null);
export function useAccount() {
  const value = useContext(AccountContext);
  if (!value) throw new Error("AccountProvider is missing.");
  return value;
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(registrationRequested);
  const [user, setUser] = useState<UserProfile | null>(null);
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

  const [plansOpen, setPlansOpen] = useState(false);
  const refreshVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const profile = await api.accountCurrent();
    if (version === refreshVersion.current) setUser(profile);
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
  function openUpgrade() {
    close();
    setPlansOpen(true);
  }
  function assistBlocked(action: "sign_in" | "upgrade") {
    if (action === "sign_in") {
      refreshVersion.current++;
      setUser(null);
      close();
      openProfile();
      setNotice(
        "Sign in to use assist. New accounts include 10 free requests.",
      );
    } else {
      openUpgrade();
    }
  }
  async function ensureAssist() {
    const profile = await refresh();
    if (!profile) {
      assistBlocked("sign_in");
      return false;
    }
    if (profile.assist_requests_remaining <= 0) {
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
          "Complete the verification before creating an account.",
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
        refresh,
        openProfile,
        openUpgrade,
        ensureAssist,
        assistBlocked,
      }}
    >
      {children}
      {plansOpen && (
        <SubscriptionPlans
          exhausted={user?.assist_requests_remaining === 0}
          onClose={() => setPlansOpen(false)}
        />
      )}
      {open && (
        <Dialog
          title={
            user
              ? "Your profile"
              : mode === "register"
                ? "Create an account"
                : "Sign in"
          }
          onClose={close}
        >
          <div className={styles.content}>
            {user && (
              <div className={styles.profile}>
                <UserRound size={28} />
                <strong>@{user.username}</strong>
                <span className={styles.tier}>{user.tier.toUpperCase()}</span>
                <span>
                  Joined {new Date(user.created_at).toLocaleDateString()}
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
                      Username
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
                    <p>3–32 lowercase letters, digits or underscores.</p>
                  )}
                  <label htmlFor="account-password">
                    {user ? "Current password" : "Password"}
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
                      New password
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
                        Confirm password
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
                      <p>12–128 characters.</p>
                    </>
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
                      ? "Create account"
                      : mode === "password"
                        ? "Change password"
                        : "Sign in"}
                  </button>
                </fieldset>
              </form>
            )}
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            {notice && <p role="status">{notice}</p>}
            <div className={styles.actions}>
              {!user && api.platform === "web" && (
                <button type="button" disabled={busy} onClick={switchMode}>
                  {mode === "register"
                    ? "Already have an account? Sign in"
                    : "Create an account"}
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
                  Create an account on the website
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
                    {mode === "password" ? "Cancel" : "Change password"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void logout();
                    }}
                  >
                    Sign out
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
