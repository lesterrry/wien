import { StateEffect } from "@codemirror/state";
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

export interface Player {
  play(): Promise<void>;
  stop(): Promise<void>;
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
  onChange,
  onState,
  onReady,
  onPosition,
}: {
  initialCode: string;
  onChange: (code: string) => void;
  onState: (state: ReplState) => void;
  onReady: (player: Player | null) => void;
  onPosition: (line: number, column: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onChange, onState, onReady, onPosition });
  callbacks.current = { onChange, onState, onReady, onPosition };
  const code = useRef(initialCode);

  useEffect(() => {
    if (!root.current) return;
    let alive = true;
    const mirror = new StrudelMirror({
      root: root.current,
      initialCode: code.current,
      bgFill: false,
      defaultOutput: webaudioOutput,
      getTime: () => getAudioContext().currentTime,
      transpiler,
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
    callbacks.current.onReady({
      play: () => mirror.evaluate(),
      stop: () => mirror.stop(),
    });
    return () => {
      alive = false;
      void mirror.stop();
      mirror.clear();
      mirror.editor.destroy();
      callbacks.current.onReady(null);
    };
  }, []);

  return <div className="editor" ref={root} />;
}
