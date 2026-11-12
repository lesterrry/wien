import { Loader2, UserRound } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { UserProfile } from "../../../../shared/account";
import { Dialog } from "../Dialog/Dialog";
import styles from "./Account.module.css";

const api = window.workspace;
const errorMessage = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );

export function Account({
  children,
}: {
  children: (user: UserProfile | null, openProfile: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [mode, setMode] = useState<"login" | "register" | "password">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void api
      .accountCurrent()
      .then((profile) => {
        if (active) setUser(profile);
      })
      .catch(() => { });
    return () => {
      active = false;
    };
  }, []);

  function clearPasswords() {
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
      const profile =
        mode === "password"
          ? await api.accountChangePassword({
            current_password: password,
            new_password: nextPassword,
          })
          : await (mode === "register"
            ? api.accountRegister
            : api.accountLogin)({ username, password });
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
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.accountLogout();
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
    <>
      {children(user, () => setOpen(true))}
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
                      <p>
                        12–128 characters.
                      </p>
                    </>
                  )}
                  <button className={styles.primary} type="submit">
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
              {!user && (
                <button type="button" disabled={busy} onClick={switchMode}>
                  {mode === "register"
                    ? "Already have an account? Sign in"
                    : "Create an account"}
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
    </>
  );
}
