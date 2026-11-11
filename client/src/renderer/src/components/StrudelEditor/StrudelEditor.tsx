import { Compartment, EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type ReplState, StrudelMirror } from "@strudel/codemirror";
import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import * as tonal from "@strudel/tonal";
import { transpiler } from "@strudel/transpiler";
import * as webaudio from "@strudel/webaudio";
import {
  getAudioContext,
  initAudio,
  registerSynthSounds,
  webaudioOutput,
} from "@strudel/webaudio";
import classNames from "classnames";
import { useEffect, useRef, useState } from "react";
import { useDrop } from "react-dnd";
import { changeControl, ignoreControl } from "../../../../shared/controls";
import type { Entry } from "../../../../shared/types";
import { compileGraph } from "../../module-compiler";
import {
  type AssistantPlacement,
  AssistantPopover,
} from "../AssistantPopover/AssistantPopover";
import styles from "./StrudelEditor.module.css";

export interface Player {
  assist(placement?: AssistantPlacement): void;
  play(): Promise<void>;
  stop(): Promise<void>;
  replaceCode(code: string): void;
  changeControl(name: string, value: number | boolean): void;
  ignoreControl(name: string): void;
}

let scope: Promise<unknown> | undefined;
let audio: Promise<void> | undefined;
// Strudel installs evaluation helpers (setcpm, $: tracks) in a shared scope.
// Serialize compilation/evaluation across tabs; their schedulers run independently.
let evaluationQueue: Promise<void> = Promise.resolve();

function withEvaluationLock(evaluate: () => Promise<void>) {
  const next = evaluationQueue.then(evaluate);
  evaluationQueue = next.catch(() => {});
  return next;
}

function prepareScope() {
  scope ??= Promise.all([
    core.evalScope(core, mini, tonal, webaudio),
    registerSynthSounds(),
  ]);
  return scope;
}

export function StrudelEditor({
  initialCode,
  path,
  active,
  disabled,
  onLink,
  onChange,
  onState,
  onReady,
  onPosition,
}: {
  initialCode: string;
  path: string;
  active: boolean;
  disabled: boolean;
  onLink: (source: string) => void;
  onChange: (code: string) => void;
  onState: (state: ReplState) => void;
  onReady: (player: Player | null) => void;
  onPosition: (line: number, column: number) => void;
}) {
  const [view, setView] = useState<EditorView | null>(null);
  const [assistantInvocation, setAssistantInvocation] = useState(0);
  const [assistantPlacement, setAssistantPlacement] =
    useState<AssistantPlacement>("cursor");
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const readOnly = useRef(new Compartment());
  const [{ isOver, canDrop }, drop] = useDrop(
    () => ({
      accept: "NODE",
      canDrop: (item: { id: string; data: Entry }) =>
        !disabled && !item.data.children && item.id !== path,
      drop: (item: { id: string; data: Entry }) => {
        onLink(item.id);
        return { linked: true };
      },
      collect: (monitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
      }),
    }),
    [disabled, onLink, path],
  );
  const callbacks = useRef({ onChange, onState, onReady, onPosition });
  callbacks.current = { onChange, onState, onReady, onPosition };
  const code = useRef(initialCode);
  const pathRef = useRef(path);
  pathRef.current = path;

  useEffect(() => {
    if (!root.current) return;
    let alive = true;
    let generation = 0;
    let evaluationGeneration = 0;
    let requested: boolean | null = null;
    let evaluating: Promise<void> | undefined;
    let liveTimer: ReturnType<typeof setTimeout> | undefined;
    let evaluationCode: string | undefined;
    let compiled: ReturnType<typeof compileGraph> | undefined;
    const mirror = new StrudelMirror({
      root: root.current,
      initialCode: code.current,
      id: crypto.randomUUID(),
      solo: false,
      bgFill: false,
      defaultOutput: webaudioOutput,
      getTime: () => getAudioContext().currentTime,
      transpiler: () => {
        if (!compiled) throw new Error("The project has not been compiled.");
        return compiled;
      },
      beforeEval: async () => {
        try {
          const graph = await window.workspace.graph(
            pathRef.current,
            evaluationCode ?? mirror.code,
          );
          if (!alive || evaluationGeneration !== generation)
            throw new Error("Evaluation cancelled.");
          compiled = compileGraph(graph, transpiler);
        } catch (error) {
          throw new Error(
            String(error instanceof Error ? error.message : error).replace(
              /^Error invoking remote method '[^']+': Error: /,
              "",
            ),
          );
        }
      },
      prebake: prepareScope,
      beforeStart: async () => {
        audio ??= initAudio().catch((error) => {
          audio = undefined;
          throw error;
        });
        await audio;
        await getAudioContext().resume();
        if (!alive || evaluationGeneration !== generation)
          throw new Error("Playback cancelled.");
      },
      onUpdateState: (state) => {
        if (alive) callbacks.current.onState({ ...state });
      },
    });
    mirror.setTheme("githubDark");
    mirror.setFontSize(14);
    mirror.setFontFamily(
      '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    );
    mirror.setLineWrappingEnabled(true);
    mirror.editor.dispatch({
      effects: StateEffect.appendConfig.of([
        readOnly.current.of([]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged)
            callbacks.current.onChange(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            callbacks.current.onPosition(line.number, head - line.from + 1);
          }
        }),
      ]),
    });
    // Serialize evaluations and coalesce fast knob gestures into the latest code.
    // autostart=false swaps the running pattern without resetting the clock or
    // starting playback again if Stop was pressed during an async evaluation.
    const evaluateMirror = mirror.evaluate.bind(mirror);
    const stopMirror = mirror.stop.bind(mirror);
    const evaluate = (autostart: boolean): Promise<void> => {
      requested = requested === true || autostart;
      if (evaluating) return evaluating;
      const drain = async () => {
        while (alive && requested !== null) {
          const start = requested;
          requested = null;
          if (!start && !mirror.repl.state.started) continue;
          const token = generation;
          await withEvaluationLock(async () => {
            if (!alive || token !== generation) return;
            evaluationGeneration = token;
            evaluationCode = mirror.code;
            await evaluateMirror(false);
            if (
              alive &&
              token === generation &&
              start &&
              !mirror.repl.state.error &&
              !mirror.repl.state.started
            )
              await mirror.repl.start();
          });
        }
      };
      evaluating = drain().finally(() => {
        evaluating = undefined;
        evaluationCode = undefined;
      });
      return evaluating;
    };
    const cancelLive = () => {
      generation++;
      clearTimeout(liveTimer);
      liveTimer = undefined;
      requested = null;
    };
    // Route Strudel's own editor shortcuts through the same queue and cancellation.
    mirror.evaluate = (autostart = true) => evaluate(autostart);
    mirror.stop = () => {
      cancelLive();
      return stopMirror();
    };
    callbacks.current.onReady({
      assist: (placement = "cursor") => {
        setAssistantPlacement(placement);
        setAssistantInvocation((value) => value + 1);
      },
      play: () => evaluate(true),
      stop: () => mirror.stop(),
      changeControl: (name, value) => {
        const edit = changeControl(mirror.code, name, value);
        if (!edit) return;
        mirror.editor.dispatch({
          changes: { from: edit.start, to: edit.end, insert: edit.text },
        });
        if (!mirror.repl.state.started || liveTimer !== undefined) return;
        liveTimer = setTimeout(() => {
          liveTimer = undefined;
          if (alive && mirror.repl.state.started) void evaluate(false);
        }, 60);
      },
      ignoreControl: (name) => {
        const edit = ignoreControl(mirror.code, name);
        if (edit)
          mirror.editor.dispatch({
            changes: { from: edit.start, to: edit.end, insert: edit.text },
          });
      },
      replaceCode: (code) =>
        mirror.editor.dispatch({
          changes: {
            from: 0,
            to: mirror.editor.state.doc.length,
            insert: code,
          },
        }),
    });
    editor.current = mirror.editor;
    setView(mirror.editor);
    return () => {
      alive = false;
      cancelLive();
      editor.current = null;
      void mirror.stop();
      mirror.clear();
      mirror.editor.destroy();
      callbacks.current.onReady(null);
    };
  }, []);

  useEffect(() => {
    if (active) editor.current?.requestMeasure();
  }, [active]);

  useEffect(() => {
    editor.current?.dispatch({
      effects: readOnly.current.reconfigure([
        EditorState.readOnly.of(disabled),
        EditorView.editable.of(!disabled),
        EditorView.contentAttributes.of({
          "aria-label": active
            ? "Strudel code editor"
            : "Background snippet editor",
        }),
      ]),
    });
  }, [disabled, active]);

  return (
    <>
      <div
        className={classNames(styles.editor, {
          [styles.linkDropActive]: isOver && canDrop,
        })}
        ref={(node) => {
          root.current = node;
          drop(node);
        }}
        data-drop-hint="Release to import snippet"
      />
      {view && (
        <AssistantPopover
          view={view}
          path={path}
          invocation={assistantInvocation}
          placement={assistantPlacement}
          disabled={disabled || !active}
        />
      )}
    </>
  );
}
