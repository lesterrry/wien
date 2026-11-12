export interface AssistRequest {
  prompt: string;
  file: {
    path: string;
    content: string;
    cursor: { anchor: number; head: number };
  };
}

export interface AssistResponse {
  message: string;
  code: string | null;
}

export type AssistResult = AssistResponse | { action: "sign_in" | "upgrade" };
