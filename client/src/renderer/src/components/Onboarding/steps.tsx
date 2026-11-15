import {
  AudioLines,
  History,
  type LucideIcon,
  Network,
  Paperclip,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  type CommandId,
  commands,
  shortcutLabel,
} from "../../../../shared/commands";
import { shortcutEnvironment } from "../../commands";
import { t, useLocale } from "../../i18n";

export type TourTopic =
  | "play"
  | "controls"
  | "assist"
  | "audio"
  | "modules"
  | "save"
  | "wav";
export interface TourStep {
  id: TourTopic;
  label: string;
  icon: LucideIcon;
  title: string;
  description: string;
  instructions: { title: string; body: ReactNode }[];
  tip?: ReactNode;
}

function Shortcut({ command }: { command: CommandId }) {
  useLocale();
  const definition = commands.find((item) => item.id === command);
  return definition ? (
    <kbd>{shortcutLabel(definition, shortcutEnvironment)}</kbd>
  ) : null;
}

export function tourSteps(web: boolean): TourStep[] {
  return [
    {
      id: "play",
      label: t("Play & edit"),
      icon: AudioLines,
      title: t("Start with a sound."),
      description: t(
        "Wien turns small pieces of Strudel code into music. Your first project already has a whole track waiting inside.",
      ),
      instructions: [
        {
          title: t("Press Play"),
          body: (
            <>
              {t("Open a snippet and click Play, or press")}{" "}
              <Shortcut command="play" />
              {t(". In the default project, start with glass-nerve.strudel.")}
            </>
          ),
        },
        {
          title: t("Change something. Hear it."),
          body: (
            <>
              {t(
                "Edit a note, a rhythm or an effect, then click Update. Stop the current snippet with",
              )}{" "}
              <Shortcut command="stop" />
              {t("; undo an edit with")} <Shortcut command="undo" />.
            </>
          ),
        },
        {
          title: t("Keep a few ideas playing"),
          body: (
            <>
              {t(
                "Open files in separate tabs. They keep playing when you switch tabs, each with its own tempo and clock. Use",
              )}{" "}
              <Shortcut command="stopAll" /> {t("to stop all of them.")}
            </>
          ),
        },
      ],
      tip: t(
        "Built-in synths work offline. Drum samples and soundfonts download when you first use them.",
      ),
    },
    {
      id: "controls",
      label: t("Shape the sound"),
      icon: SlidersHorizontal,
      title: t("Your code becomes an instrument."),
      description: t(
        "Controls turns top-level variables into knobs, sliders, switches and choices. Try the preview below.",
      ),
      instructions: [
        {
          title: t("Create a control in code"),
          body: (
            <>
              {t("Declare a top-level variable, such as")}{" "}
              <code>const cutoff = 1200</code>
              {t(", and use it in your pattern’s")} <code>.lpf(cutoff)</code>
              {t(
                ". Wien automatically gives numbers knobs and booleans switches. Variables inside functions stay private.",
              )}
            </>
          ),
        },
        {
          title: t("Make the panel yours"),
          body: (
            <>
              {t("Add")} <code>{"// @slider 200..8000"}</code>{" "}
              {t("beside the variable to create a slider. Use")}{" "}
              <code>{"// @knob step=100"}</code>{" "}
              {t("for a knob with a custom step. A choice from an")}{" "}
              <code>Object.freeze</code>{" "}
              {t(
                "enum becomes a dropdown. The gear lets you adjust presentation, range and defaults without writing annotations.",
              )}
            </>
          ),
        },
        {
          title: t("Play it like an instrument"),
          body: t(
            "Drag controls or use arrow keys; hold Shift for finer changes. Controls update the sound while playing. Imported voices get their own groups; pin the master to keep them in reach. The reset arrow restores a default, and clicking a name jumps to its code.",
          ),
        },
      ],
    },
    {
      id: "assist",
      label: t("Ask Assist"),
      icon: Sparkles,
      title: t("Describe the change you hear."),
      description: t(
        "Ask for a rhythm, a different mood, an explanation or help with an error, right beside your code.",
      ),
      instructions: [
        {
          title: t("Open Assist at the cursor"),
          body: (
            <>
              {t("Click the sparkle button or press")}{" "}
              <Shortcut command="assist" />
              {t(
                ". Select a phrase first if you want to point out a particular part.",
              )}
            </>
          ),
        },
        {
          title: t("Be specific"),
          body: (
            <>
              {t(
                "Ask for musical changes or new controls: “Add a cutoff knob and a reverb slider.” Assist creates the variables and annotations for you. Enter sends; Shift + Enter adds a line. Your selection is context; Assist can change the whole current file.",
              )}
            </>
          ),
        },
        {
          title: t("Listen, then decide"),
          body: (
            <>
              {t(
                "Edits appear directly in the editor. Press Play / Update to hear them, or return to the editor and use",
              )}{" "}
              <Shortcut command="undo" /> {t("to undo. Esc closes Assist.")}
            </>
          ),
        },
      ],
    },
    {
      id: "audio",
      label: t("Start from audio"),
      icon: Paperclip,
      title: t("Turn a sound into a snippet."),
      description: t(
        "Give Assist a short audio reference to recreate as editable Strudel code, from its notes and rhythm to its tempo.",
      ),
      instructions: [
        {
          title: t("Attach an MP3"),
          body: t(
            "Open Assist, click the paperclip and choose an MP3 from your computer.",
          ),
        },
        {
          title: t("Choose the part you want"),
          body: t(
            "Select up to 10 seconds on the waveform. Drag the selection or adjust its start and end times, then preview it. Only the selected excerpt is sent to Assist.",
          ),
        },
        {
          title: t("Make it your own"),
          body: (
            <>
              {t(
                "Add a request such as “Recreate the melody and tempo,” or send just the audio. The result replaces the current snippet. Press Play / Update to listen, tweak the code, or use",
              )}{" "}
              <Shortcut command="undo" /> {t("to undo.")}
            </>
          ),
        },
      ],
    },
    {
      id: "modules",
      label: t("Connect your ideas"),
      icon: Network,
      title: t("Small parts. A bigger track."),
      description: t(
        "Keep a melody, a drum pattern or an instrument in its own file, then combine them in a master snippet.",
      ),
      instructions: [
        {
          title: t("Bring a voice into the master"),
          body: t(
            "Drag a snippet from the explorer into the editor. Wien makes it exportable and adds an import. Use the imported name in your pattern, for example stack(keys, drums).",
          ),
        },
        {
          title: t("Follow the connections"),
          body: t(
            "Open Graph View at the bottom left. Arrows point from a dependency to the file using it. Double-click a node to open its code; use ⋯ → View in Graph View to find a specific snippet.",
          ),
        },
        {
          title: t("Update the composition"),
          body: t(
            "After typing changes in a voice, Update the master to hear them together. The master sets the tempo. Moving or renaming files in the explorer updates their import paths.",
          ),
        },
      ],
    },
    {
      id: "save",
      label: t("Keep your work"),
      icon: History,
      title: t("Leave yourself a way back."),
      description: web
        ? t(
            "Try Versions here. In the desktop app, save snapshots before an experiment and restore an earlier idea whenever you like.",
          )
        : t(
            "Your files save automatically. Versions keeps named snapshots so you can always return to an earlier idea.",
          ),
      instructions: [
        {
          title: t("Save a version"),
          body: t(
            "Open Versions below the explorer. Give the moment a short name and save it before trying something new. Try naming a new version in the demo above.",
          ),
        },
        {
          title: t("Return to an earlier idea"),
          body: t(
            "Select a version to return to its code and listen. Return to working state brings back your latest edits. Try Restore beside a version above to move back through the timeline.",
          ),
        },
      ],
      tip: t("Git-powered. You can add a remote and push your work to GitHub."),
    },
    {
      id: "wav",
      label: t("Save your sound"),
      icon: AudioLines,
      title: t("Turn a sketch into a track."),
      description: "",
      instructions: [
        {
          title: t("Choose ⋯ → Save WAV"),
          body: t(
            "Use the three-dot menu above the editor, or a file’s menu in the explorer. The export starts at the beginning; other playing tabs are not mixed in.",
          ),
        },
        {
          title: t("Choose the length"),
          body: t(
            "Set the number of cycles — usually one cycle is one bar — and leave an effect tail for reverb and delay. For the full Glass Nerve arrangement, choose 96 cycles.",
          ),
        },
        {
          title: t("Render and save"),
          body: web
            ? t(
                "Optionally normalize the peak, then click Save WAV. The stereo WAV downloads when rendering finishes. You can cancel a render at any time.",
              )
            : t(
                "Optionally normalize the peak, then click Save WAV and choose where to save it. If you cancel the file dialog, click Save WAV again without re-rendering.",
              ),
        },
      ],
    },
  ];
}
