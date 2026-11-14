export interface AssistRequest {
  prompt: string;
  turbo?: boolean;
  audio?: { wav_base64: string };
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
