export const tiers = ["free", "plus", "pro", "ultra"] as const;
export type Tier = (typeof tiers)[number];

export interface UserProfile {
  id: string;
  username: string;
  created_at: string;
  tier: Tier;
  assist_requests_remaining: number;
}

export interface Credentials {
  username: string;
  password: string;
}

export interface Registration extends Credentials {
  turnstile_token: string;
}

export interface PasswordChange {
  current_password: string;
  new_password: string;
}
