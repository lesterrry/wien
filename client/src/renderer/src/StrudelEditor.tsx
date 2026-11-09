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
import { useEffect, useRef } from "react";
import { useDrop } from "react-dnd";
import { changeControl, ignoreControl } from "../../shared/controls";
import type { Entry } from "../../shared/types";
import { compileGraph } from "./module-compiler";

export interface Player {
  play(): Promise<void>;
  stop(): Promise<void>;
  replaceCode(code: string): void;
  changeControl(name: string, value: number): void;
  ignoreControl(name: string): void;
}

let scope: Promise<unknown> | undefined;
let audio: Promise<void> | undefined;

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
  disabled,
  onLink,
  onChange,
  onState,
  onReady,
  onPosition,
}: {
  initialCode: string;
  path: string;
  disabled: boolean;
  onLink: (source: string) => void;
  onChange: (code: string) => void;
  onState: (state: ReplState) => void;
  onReady: (player: Player | null) => void;
  onPosition: (line: number, column: number) => void;
}) {
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

  useEffect(() => {
    if (!root.current) return;
    let alive = true;
    let requested: boolean | null = null;
    let evaluating: Promise<void> | undefined;
    let liveTimer: ReturnType<typeof setTimeout> | undefined;
    let evaluationCode: string | undefined;
    let compiled: ReturnType<typeof compileGraph> | undefined;
    const mirror = new StrudelMirror({
      root: root.current,
      initialCode: code.current,
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
            path,
            evaluationCode ?? mirror.code,
          );
          if (!alive) throw new Error("Evaluation cancelled.");
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
        EditorView.contentAttributes.of({
          "aria-label": "Strudel code editor",
        }),
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
    const evaluate = (autostart: boolean): Promise<void> => {
      requested = requested === true || autostart;
      if (evaluating) return evaluating;
      const drain = async () => {
        while (alive && requested !== null) {
          const start = requested;
          requested = null;
          if (!start && !mirror.repl.state.started) continue;
          evaluationCode = mirror.code;
          await mirror.evaluate(start);
        }
      };
      evaluating = drain().finally(() => {
        evaluating = undefined;
        evaluationCode = undefined;
      });
      return evaluating;
    };
    const cancelLive = () => {
      clearTimeout(liveTimer);
      liveTimer = undefined;
      requested = null;
    };
    callbacks.current.onReady({
      play: () => evaluate(true),
      stop: () => {
        cancelLive();
        return mirror.stop();
      },
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
    return () => {
      alive = false;
      cancelLive();
      editor.current = null;
      void mirror.stop();
      mirror.clear();
      mirror.editor.destroy();
      callbacks.current.onReady(null);
    };
  }, [path]);

  useEffect(() => {
    editor.current?.dispatch({
      effects: readOnly.current.reconfigure([
        EditorState.readOnly.of(disabled),
        EditorView.editable.of(!disabled),
      ]),
    });
  }, [disabled]);

  return (
    <div
      className={`editor ${isOver && canDrop ? "link-drop-active" : ""}`}
      ref={(node) => {
        root.current = node;
        drop(node);
      }}
      data-drop-hint="Release to import snippet"
    />
  );
}
