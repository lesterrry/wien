export interface UserProfile {
  id: string;
  username: string;
  created_at: string;
}

export interface Credentials {
  username: string;
  password: string;
}

export interface PasswordChange {
  current_password: string;
  new_password: string;
}
