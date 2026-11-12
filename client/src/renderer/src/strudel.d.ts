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
      id?: string;
      initialCode: string;
      solo?: boolean;
      bgFill?: boolean;
      defaultOutput: unknown;
      getTime: () => number;
      transpiler: unknown;
      prebake: () => Promise<unknown>;
      beforeStart?: () => Promise<unknown>;
      beforeEval?: () => Promise<unknown>;
      onUpdateState: (state: ReplState) => void;
    });
    editor: EditorView;
    code: string;
    repl: {
      state: ReplState;
      start(): Promise<void>;
      scheduler: { now(): number; cps: number };
    };
    evaluate(autostart?: boolean): Promise<void>;
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
  export function reify(value: unknown): {
    queryArc(begin: number, end: number): { value: unknown }[];
  };
}
declare module "@strudel/mini";
declare module "@strudel/tonal";
declare module "@strudel/transpiler" {
  export function transpiler(
    code: string,
    options?: { emitWidgets?: boolean },
  ): {
    output: string;
    miniLocations?: number[][];
    widgets?: unknown[];
  };
}
declare module "@strudel/webaudio" {
  export function getAudioContext(): AudioContext;
  export function initAudio(): Promise<void>;
  export function registerSynthSounds(): Promise<void>;
  export function registerZZFXSounds(): void;
  export function samples(
    sampleMap: string | Record<string, unknown>,
    baseUrl?: string,
    options?: { prebake?: boolean; tag?: string },
  ): Promise<void>;
  export function aliasBank(
    aliases: Record<string, string | string[]>,
  ): Promise<void>;
  export const webaudioOutput: unknown;
}

declare module "@strudel/soundfonts" {
  export function registerSoundfonts(): void;
}

declare module "hydra-synth" {
  export default class Hydra {
    constructor(options: {
      canvas: HTMLCanvasElement;
      makeGlobal: boolean;
      autoLoop: boolean;
      detectAudio: boolean;
      enableStreamCapture: boolean;
      width?: number;
      height?: number;
      numSources?: number;
      numOutputs?: number;
      precision?: string;
      extendTransforms?: Record<string, unknown>;
    });
    synth: Record<string, unknown>;
    s: { clear(): void }[];
    regl: { destroy(): void };
    tick(delta: number): void;
  }
}
