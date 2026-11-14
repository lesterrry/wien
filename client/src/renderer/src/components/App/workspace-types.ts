import type { Entry } from "../../../../shared/types";
export type FileOperation =
  | { kind: "create"; parent: string; folder: boolean }
  | { kind: "rename"; entry: Entry }
  | { kind: "move"; entry: Entry }
  | { kind: "delete"; entry: Entry }
  | { kind: "reload" };
export type Modal =
  | FileOperation
  | { kind: "examples" }
  | { kind: "audio-export"; path: string }
  | { kind: "help" }
  | { kind: "onboarding" };
