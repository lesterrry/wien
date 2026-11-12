import type {
  Credentials,
  PasswordChange,
  UserProfile,
} from "../shared/account";

export interface TokenStore {
  read(): Promise<string | null>;
  write(token: string | null): Promise<void>;
}

const messages: Record<string, string> = {
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
    !Number.isFinite(Date.parse(value.created_at))
  ) {
    throw new Error("Invalid account response.");
  }
  return {
    id: value.id,
    username: value.username,
    created_at: value.created_at,
  };
}

export class AccountClient {
  constructor(
    private readonly origin: string,
    private readonly store: TokenStore,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async call(
    path: string,
    method: string,
    body?: unknown,
    authenticated = false,
  ): Promise<unknown> {
    const token = authenticated ? await this.store.read() : null;
    if (authenticated && !token)
      throw new Error(messages.authentication_required);
    let response: Response;
    try {
      response = await this.request(`${this.origin}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
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
        await this.store.write(null);
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
      !("token" in result) ||
      typeof result.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(result.token) ||
      !("user" in result)
    )
      throw new Error("Invalid account response.");
    const user = profile(result.user);
    await this.store.write(result.token);
    return user;
  }
  register(credentials: Credentials) {
    return this.signedIn("/auth/register", credentials);
  }
  login(credentials: Credentials) {
    return this.signedIn("/auth/login", credentials);
  }
  changePassword(request: PasswordChange) {
    return this.signedIn("/users/me/password", request, true);
  }
  async current(): Promise<UserProfile | null> {
    if (!(await this.store.read())) return null;
    try {
      return profile(await this.call("/users/me", "GET", undefined, true));
    } catch (error) {
      if (!(await this.store.read())) return null;
      throw error;
    }
  }
  async logout(): Promise<void> {
    if (await this.store.read())
      await this.call("/auth/logout", "POST", undefined, true);
    await this.store.write(null);
  }
}
