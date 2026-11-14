import type { ReplState } from "@strudel/codemirror";
import classNames from "classnames";
import { FileCode2, Network, Play, Sparkles, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readControls } from "../../../../shared/controls";
import { loadGraph } from "../../../../shared/modules";
import { AssistantContent } from "../AssistantPopover/AssistantContent";
import assistantStyles from "../AssistantPopover/AssistantPopover.module.css";
import { NumberSlider } from "../NumberSlider/NumberSlider";
import { type Player, StrudelEditor } from "../StrudelEditor/StrudelEditor";
import styles from "./Onboarding.module.css";
import type { TourTopic } from "./steps";
import { TourGraph } from "./TourGraph";

const melody = `setcpm(120 / 4)
note("c4 e4 g4 b4").s("sine")
  .gain(0.2).room(0.3)`;
const chords = `note("<c4,e4,g4 a3,c4,e4>")
  .s("triangle").gain(0.15)
// Try typing in Assist below.
// Press Play to hear the change.`;
const suspended = chords.replace("<c4,e4,g4 a3,c4,e4>", "<c4,f4,g4 a3,d4,e4>");
const requestText = "Make the chords more suspended";

function initialFiles(topic: TourTopic): Record<string, string> {
  if (topic === "modules")
    return {
      "track.strudel": `import keys from './keys.strudel'
import drums from './drums.strudel'
setcpm(120 / 4)
stack(keys, drums)`,
      "keys.strudel": `export default note("c4 e4 g4 b4")
  .s("triangle").gain(0.18).room(0.3)`,
      "drums.strudel": `export default note("c2*4").s("sine")
  .penv(24).pdecay(0.08).decay(0.12)
  .sustain(0).gain(0.25)`,
    };
  return {
    "idea.strudel":
      topic === "assist"
        ? chords
        : topic === "controls"
          ? `setcpm(120 / 4)
const cutoff = 1200 // @slider 200..8000
note("c4 e4 g4 b4").s("sawtooth")
  .lpf(cutoff).gain(0.12)`
          : melody,
  };
}

export function TourSandbox({ topic }: { topic: TourTopic }) {
  const [files, setFiles] = useState(() => initialFiles(topic));
  const filesRef = useRef(files);
  filesRef.current = files;
  const [path, setPath] = useState(Object.keys(files)[0]);
  const [graphOpen, setGraphOpen] = useState(topic === "modules");
  const [assistOpen, setAssistOpen] = useState(true);
  const player = useRef<Player | null>(null);
  const [state, setState] = useState<ReplState>();
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const code = files[path];
  const cutoff = readControls(code).controls.find(
    (control) => control.name === "cutoff" && control.kind === "slider",
  );
  const sandbox = useRef({
    graph: (entry: string, source: string) =>
      loadGraph(entry, async (file) => {
        if (file === entry) return source;
        if (!Object.hasOwn(filesRef.current, file))
          throw new Error(`No file named ${file} in this demo.`);
        return filesRef.current[file];
      }),
  });

  useEffect(() => () => clearTimeout(timer.current), []);

  function run(action: () => Promise<void> | undefined) {
    setError(null);
    void action()?.catch((error: unknown) =>
      setError(String(error instanceof Error ? error.message : error)),
    );
  }
  function cancel() {
    clearTimeout(timer.current);
    timer.current = undefined;
    setPending(false);
  }
  function submit() {
    if (!prompt || timer.current || answer) return;
    setPrompt(requestText);
    setPending(true);
    setAnswer(null);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      // A scripted, local demonstration: never use the account or Assist API.
      player.current?.replaceCode(
        code.includes("<c4,e4,g4 a3,c4,e4>")
          ? code.replace("<c4,e4,g4 a3,c4,e4>", "<c4,f4,g4 a3,d4,e4>")
          : suspended,
      );
      setAnswer(
        "Replaced the thirds with fourths for **Csus4 → Asus4**. Press Play / Update to hear the more open sound.",
      );
      setPrompt("");
      setPending(false);
    }, 2000);
  }

  return (
    <div className={styles.preview} data-tour-sandbox={topic}>
      <div className={styles.previewHeading}>
        <FileCode2 size={14} />{" "}
        {topic === "modules" ? "A connected track" : "Try it here"}
        {!graphOpen && (
          <>
            {topic === "assist" && (
              <button
                type="button"
                className={styles.assistToggle}
                aria-label="Toggle demo Assist"
                aria-expanded={assistOpen}
                onClick={() => setAssistOpen(!assistOpen)}
              >
                <Sparkles size={14} />
              </button>
            )}
            <div className={styles.transport}>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={pending}
                onClick={() => run(() => player.current?.play())}
              >
                <Play size={13} /> {state?.started ? "Update" : "Play"}
              </button>
              {state?.started && (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => run(() => player.current?.stop())}
                >
                  <Square size={12} /> Stop
                </button>
              )}
            </div>
          </>
        )}
      </div>
      {topic === "modules" && (
        <div className={styles.fileTabs} role="tablist" aria-label="Demo files">
          <button
            type="button"
            role="tab"
            aria-selected={graphOpen}
            onClick={() => {
              run(() => player.current?.stop());
              setState(undefined);
              setGraphOpen(true);
            }}
          >
            <Network size={13} /> Graph View
          </button>
          {Object.keys(files).map((file) => (
            <button
              key={file}
              type="button"
              role="tab"
              aria-selected={!graphOpen && file === path}
              onClick={() => {
                if (!graphOpen && file === path) return;
                setGraphOpen(false);
                setState(undefined);
                setError(null);
                setPath(file);
              }}
            >
              {file}
            </button>
          ))}
        </div>
      )}
      {graphOpen ? (
        <TourGraph
          files={files}
          onOpen={(file) => {
            setPath(file);
            setGraphOpen(false);
          }}
        />
      ) : (
        <div className={styles.editorStage}>
          <div className={styles.demoEditor}>
            <StrudelEditor
              key={path}
              initialCode={code}
              path={path}
              active
              disabled={pending}
              sandbox={sandbox.current}
              onLink={() => {}}
              onPosition={() => {}}
              onReady={(value) => {
                player.current = value;
              }}
              onState={setState}
              onChange={(value) => {
                setFiles((current) => ({ ...current, [path]: value }));
              }}
            />
          </div>
          {topic === "assist" && assistOpen && (
            <section
              className={classNames(
                assistantStyles.panel,
                styles.floatingAssistant,
              )}
              aria-label="Assist demo"
              aria-busy={pending}
            >
              <AssistantContent
                prompt={prompt}
                answer={answer}
                showComposer={!answer}
                pending={pending}
                placeholder="Try typing..."
                onPromptChange={(value) =>
                  setPrompt((current) =>
                    requestText.slice(
                      0,
                      value.length < current.length
                        ? value.length
                        : current.length +
                            Math.max(1, value.length - current.length),
                    ),
                  )
                }
                onSubmit={submit}
                onCancel={cancel}
                onClose={() => {
                  cancel();
                  setAssistOpen(false);
                }}
              />
            </section>
          )}
        </div>
      )}
      {topic === "controls" && cutoff?.kind === "slider" && (
        <div className={styles.demoControl}>
          <NumberSlider
            control={cutoff}
            disabled={false}
            onDefinition={(name) => player.current?.revealControl(name)}
            onChange={(name, value) => {
              player.current?.changeControl(name, { type: "set", value });
              run(() => player.current?.update({ flash: false }));
            }}
          />
        </div>
      )}
      {(error || state?.error) && (
        <p role="alert" className={styles.demoError}>
          {error || String(state?.error)}
        </p>
      )}
    </div>
  );
}
