declare module "@strudel/codemirror" {
  import type { EditorView } from "@codemirror/view";
  export interface ReplState {
    started: boolean;
    pending: boolean;
    error?: Error;
  }
  export class StrudelMirror {
    constructor(options: {
      root: HTMLElement;
      initialCode: string;
      solo?: boolean;
      bgFill?: boolean;
      defaultOutput: unknown;
      getTime: () => number;
      transpiler: unknown;
      prebake: () => Promise<unknown>;
      beforeStart?: () => Promise<unknown>;
      onUpdateState: (state: ReplState) => void;
    });
    editor: EditorView;
    code: string;
    repl: {
      state: ReplState;
      scheduler: { now(): number; cps: number };
    };
    evaluate(): Promise<void>;
    stop(): Promise<void>;
    clear(): void;
    setTheme(theme: string): void;
    setFontSize(size: number): void;
    setFontFamily(family: string): void;
    setLineWrappingEnabled(enabled: boolean): void;
  }
}

declare module "@strudel/core" {
  export function evalScope(...modules: unknown[]): Promise<unknown>;
}
declare module "@strudel/mini";
declare module "@strudel/tonal";
declare module "@strudel/transpiler" {
  export const transpiler: unknown;
}
declare module "@strudel/webaudio" {
  export function getAudioContext(): AudioContext;
  export function initAudio(): Promise<void>;
  export function registerSynthSounds(): Promise<void>;
  export const webaudioOutput: unknown;
}
