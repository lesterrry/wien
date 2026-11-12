import type {
  Credentials,
  PasswordChange,
  Registration,
  UserProfile,
} from "./account";
import { tiers } from "./account";

export interface TokenStore {
  read(): Promise<string | null>;
  write(token: string | null): Promise<void>;
}

const messages: Record<string, string> = {
  captcha_failed: "Verification expired or failed. Complete it again.",
  registration_unavailable:
    "Registration verification is unavailable. Please try again later.",
  web_registration_required: "Create your account on the Wien website.",
  username_taken: "This username is already taken.",
  invalid_credentials: "Incorrect username or password.",
  authentication_required: "Your session has expired. Sign in again.",
  invalid_account_request:
    "Use 3–32 lowercase letters, digits or underscores for your username and 12–128 characters for your password.",
  auth_rate_limited: "Too many attempts. Try again in 15 minutes.",
  accounts_unavailable:
    "Accounts are temporarily unavailable. Try again later.",
};

function profile(value: unknown): UserProfile {
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("username" in value) ||
    typeof value.username !== "string" ||
    !/^[a-z0-9_]{3,32}$/.test(value.username) ||
    !("created_at" in value) ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    !("tier" in value) ||
    !tiers.some((tier) => tier === value.tier) ||
    !("assist_requests_remaining" in value) ||
    typeof value.assist_requests_remaining !== "number" ||
    !Number.isSafeInteger(value.assist_requests_remaining) ||
    value.assist_requests_remaining < 0
  ) {
    throw new Error("Invalid account response.");
  }
  return {
    id: value.id,
    username: value.username,
    created_at: value.created_at,
    tier: value.tier as UserProfile["tier"],
    assist_requests_remaining: value.assist_requests_remaining,
  };
}

export class AccountClient {
  constructor(
    private readonly origin: string,
    private readonly store: TokenStore | null,
    private readonly request: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async call(
    path: string,
    method: string,
    body?: unknown,
    authenticated = false,
  ): Promise<unknown> {
    const token = authenticated && this.store ? await this.store.read() : null;
    if (authenticated && this.store && !token)
      throw new Error(messages.authentication_required);
    let response: Response;
    try {
      response = await this.request(`${this.origin}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(!this.store ? { "X-Wien-Session": "cookie" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        credentials: this.store ? "omit" : "same-origin",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(
        "Cannot reach the account server. Check the backend address and connection.",
      );
    }
    const result: unknown =
      response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const code =
        result && typeof result === "object" && "code" in result
          ? result.code
          : null;
      // Wrong current password is a credentials error, not an expired session.
      if (
        authenticated &&
        response.status === 401 &&
        code === "authentication_required"
      )
        await this.store?.write(null);
      if (!this.store && path === "/users/me" && response.status === 401)
        return null;
      if (response.status === 403 && !code)
        throw new Error(
          "Cloudflare blocked this request. The server's bot protection needs to allow the desktop app.",
        );
      throw new Error(
        (typeof code === "string" && messages[code]) ||
          "The account request failed. Try again later.",
      );
    }
    return result;
  }

  private async signedIn(
    path: string,
    body: unknown,
    authenticated = false,
  ): Promise<UserProfile> {
    const result = await this.call(path, "POST", body, authenticated);
    if (
      !result ||
      typeof result !== "object" ||
      (this.store !== null &&
        (!("token" in result) ||
          typeof result.token !== "string" ||
          !/^[a-f0-9]{64}$/.test(result.token))) ||
      !("user" in result)
    )
      throw new Error("Invalid account response.");
    const user = profile(result.user);
    if (this.store && "token" in result)
      await this.store.write(result.token as string);
    return user;
  }
  register(credentials: Registration) {
    if (this.store) throw new Error(messages.web_registration_required);
    return this.signedIn("/auth/register", credentials);
  }
  login(credentials: Credentials) {
    return this.signedIn("/auth/login", credentials);
  }
  changePassword(request: PasswordChange) {
    return this.signedIn("/users/me/password", request, true);
  }
  async current(): Promise<UserProfile | null> {
    if (this.store && !(await this.store.read())) return null;
    try {
      const result = await this.call("/users/me", "GET", undefined, true);
      return result === null ? null : profile(result);
    } catch (error) {
      if (this.store && !(await this.store.read())) return null;
      throw error;
    }
  }
  async logout(): Promise<void> {
    if (!this.store || (await this.store.read()))
      await this.call("/auth/logout", "POST", undefined, true);
    await this.store?.write(null);
  }
}
