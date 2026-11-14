export interface SubscriptionPlan {
  id: string;
  name: string;
  description: string;
  features: string[];
  price_minor: number;
  currency: string;
  currency_minor_units: number;
  billing_period: "none" | "month" | "year";
  initial_assist_requests: number | null;
  audio_enabled: boolean;
  is_default: boolean;
}

export interface UserProfile {
  id: string;
  username: string;
  created_at: string;
  tier: string;
  plan: SubscriptionPlan;
  assist_requests_remaining: number;
  audio_requests_used: number;
  assist_requests_used: number;
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
