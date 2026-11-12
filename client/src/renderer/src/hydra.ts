import { reify } from "@strudel/core";
import Hydra from "hydra-synth";

interface HydraOptions {
  width?: number;
  height?: number;
  numSources?: number;
  numOutputs?: number;
  precision?: string;
  extendTransforms?: Record<string, unknown>;
  detectAudio?: boolean;
  feedStrudel?: boolean;
  makeGlobal?: boolean;
  autoLoop?: boolean;
  enableStreamCapture?: boolean;
}

interface HydraSession {
  wrap(code: string): string;
  clear(): void;
  start(): void;
}

const supportedOptions: Record<string, true> = {
  width: true,
  height: true,
  numSources: true,
  numOutputs: true,
  precision: true,
  extendTransforms: true,
  detectAudio: true,
  feedStrudel: true,
  makeGlobal: true,
  autoLoop: true,
  enableStreamCapture: true,
};

const evaluations = new Map<string, object>();

// The scope is lexical, not global: callbacks retain their own tab's Hydra DSL.
// Missing names continue to resolve to Strudel's ordinary evaluation globals.
export function evaluateHydra(id: string, code: string) {
  const scope = evaluations.get(id);
  if (!scope) throw new Error("Hydra evaluation cancelled.");
  return Function(
    "scope",
    `with (scope) { return (async () => { "use strict";\n${code}\n})() }`,
  )(scope);
}

export function createHydraRuntime(host: HTMLElement, now: () => number) {
  let current: HydraSession | undefined;
  function createSession() {
    const id = crypto.randomUUID();
    let valid = true;
    let hydra: Hydra | undefined;
    let configuration: HydraOptions | undefined;
    let frame: number | undefined;
    let previousTime: number | undefined;
    let canvas: HTMLCanvasElement | undefined;

    const clear = () => {
      valid = false;
      evaluations.delete(id);
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      if (hydra) {
        for (const source of hydra.s) source.clear();
        hydra.regl.destroy();
        canvas
          ?.getContext("webgl")
          ?.getExtension("WEBGL_lose_context")
          ?.loseContext();
        hydra = undefined;
      }
      canvas?.remove();
      host.hidden = true;
    };
    const initHydra = async (options: HydraOptions = {}) => {
      if (!valid) throw new Error("Hydra evaluation cancelled.");
      for (const key of Object.keys(options)) {
        if (!Object.hasOwn(supportedOptions, key))
          throw new Error(
            `initHydra: option '${key}' is not supported in Wien.`,
          );
      }
      for (const key of [
        "detectAudio",
        "feedStrudel",
        "makeGlobal",
        "autoLoop",
        "enableStreamCapture",
      ] as const) {
        if (options[key])
          throw new Error(`initHydra: ${key}: true is not supported in Wien.`);
      }
      if (hydra) {
        if (
          Object.keys({ ...configuration, ...options }).some(
            (key) =>
              Reflect.get(configuration ?? {}, key) !==
              Reflect.get(options, key),
          )
        )
          throw new Error("initHydra: use one configuration per evaluation.");
        return hydra;
      }
      configuration = { ...options };
      canvas = document.createElement("canvas");
      canvas.setAttribute("aria-label", "Hydra visuals");
      canvas.setAttribute("role", "img");
      canvas.width = options.width ?? 640;
      canvas.height = options.height ?? 360;
      host.append(canvas);
      host.hidden = false;
      try {
        hydra = new Hydra({
          ...options,
          canvas,
          width: canvas.width,
          height: canvas.height,
          makeGlobal: false,
          autoLoop: false,
          detectAudio: false,
          enableStreamCapture: false,
        });
      } catch (error) {
        canvas
          .getContext("webgl")
          ?.getExtension("WEBGL_lose_context")
          ?.loseContext();
        clear();
        throw error;
      }
      return hydra;
    };
    const samplePattern = (pattern: unknown) => () => {
      const time = now();
      return reify(pattern).queryArc(time, time)[0].value;
    };
    const bindings = {
      initHydra,
      clearHydra: clear,
      H: samplePattern,
    };
    const scope = new Proxy(bindings, {
      has: (target, name) =>
        Object.hasOwn(target, name) ||
        (hydra !== undefined && Object.hasOwn(hydra.synth, name)),
      get: (target, name) => {
        if (name === Symbol.unscopables) return undefined;
        if (Object.hasOwn(target, name)) return Reflect.get(target, name);
        return hydra?.synth[String(name)];
      },
      set: (_target, name, value) => {
        if (!hydra) return false;
        hydra.synth[String(name)] = value;
        return true;
      },
    });
    evaluations.set(id, scope);
    return {
      wrap: (code: string) =>
        `return globalThis.__wienEvaluateHydra(${JSON.stringify(id)}, ${JSON.stringify(code)});`,
      clear,
      start: () => {
        evaluations.delete(id);
        if (!valid || !hydra || frame !== undefined) return;
        const draw = (time: number) => {
          if (!valid || !hydra) return;
          hydra.tick(previousTime === undefined ? 0 : time - previousTime);
          previousTime = time;
          frame = requestAnimationFrame(draw);
        };
        frame = requestAnimationFrame(draw);
      },
    };
  }

  return {
    begin: () => {
      current?.clear();
      current = createSession();
    },
    wrap: (code: string) => {
      if (!current) throw new Error("Hydra evaluation has not started.");
      return current.wrap(code);
    },
    start: () => current?.start(),
    clear: () => {
      current?.clear();
      current = undefined;
    },
  };
}
