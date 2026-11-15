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
  ai_usage_multiplier?: number | null;
  name_ru?: string | null;
  description_ru?: string | null;
  features_ru?: string[] | null;
}

export interface UserProfile {
  id: string;
  username: string;
  created_at: string;
  tier: string;
  plan: SubscriptionPlan;
  assist_requests_remaining: number;
  subscription_expires_at?: string | null;
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
