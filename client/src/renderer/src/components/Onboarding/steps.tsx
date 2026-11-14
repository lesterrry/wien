import {
  AudioLines,
  History,
  type LucideIcon,
  Network,
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

export type TourTopic =
  | "play"
  | "controls"
  | "assist"
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
  const definition = commands.find((item) => item.id === command);
  return definition ? (
    <kbd>{shortcutLabel(definition, shortcutEnvironment)}</kbd>
  ) : null;
}

export function tourSteps(web: boolean): TourStep[] {
  return [
    {
      id: "play",
      label: "Play & edit",
      icon: AudioLines,
      title: "Start with a sound.",
      description:
        "Wien turns small pieces of Strudel code into music. Your first project already has a whole track waiting inside.",
      instructions: [
        {
          title: "Press Play",
          body: (
            <>
              Open a snippet and click Play, or press{" "}
              <Shortcut command="play" />. In the default project, start with
              glass-nerve.strudel.
            </>
          ),
        },
        {
          title: "Change something. Hear it.",
          body: (
            <>
              Edit a note, a rhythm or an effect, then click Update. Stop the
              current snippet with <Shortcut command="stop" />; undo an edit
              with <Shortcut command="undo" />.
            </>
          ),
        },
        {
          title: "Keep a few ideas playing",
          body: (
            <>
              Open files in separate tabs. They keep playing when you switch
              tabs, each with its own tempo and clock. Use{" "}
              <Shortcut command="stopAll" /> to stop all of them.
            </>
          ),
        },
      ],
      tip: "Built-in synths work offline. Drum samples and soundfonts download when you first use them.",
    },
    {
      id: "controls",
      label: "Shape the sound",
      icon: SlidersHorizontal,
      title: "Your code becomes an instrument.",
      description:
        "Controls turns top-level variables into knobs, sliders, switches and choices. Try the preview below.",
      instructions: [
        {
          title: "Create a control in code",
          body: (
            <>
              Declare a top-level variable, such as{" "}
              <code>const cutoff = 1200</code>, and use it in your pattern’s{" "}
              <code>.lpf(cutoff)</code>. Wien automatically gives numbers knobs
              and booleans switches. Variables inside functions stay private.
            </>
          ),
        },
        {
          title: "Make the panel yours",
          body: (
            <>
              Add <code>{"// @slider 200..8000"}</code> beside the variable to
              create a slider. Use <code>{"// @knob step=100"}</code> for a knob
              with a custom step. A choice from an <code>Object.freeze</code>{" "}
              enum becomes a dropdown. The gear lets you adjust presentation,
              range and defaults without writing annotations.
            </>
          ),
        },
        {
          title: "Play it like an instrument",
          body: "Drag controls or use arrow keys; hold Shift for finer changes. Controls update the sound while playing. Imported voices get their own groups; pin the master to keep them in reach. The reset arrow restores a default, and clicking a name jumps to its code.",
        },
      ],
    },
    {
      id: "assist",
      label: "Ask Assist",
      icon: Sparkles,
      title: "Describe the change you hear.",
      description:
        "Ask for a rhythm, a different mood, an explanation or help with an error, right beside your code.",
      instructions: [
        {
          title: "Open Assist at the cursor",
          body: (
            <>
              Click the sparkle button or press <Shortcut command="assist" />.
              Select a phrase first if you want to point out a particular part.
            </>
          ),
        },
        {
          title: "Be specific",
          body: (
            <>
              Ask for musical changes or new controls: “Add a cutoff knob and a
              reverb slider.” Assist creates the variables and annotations for
              you. Enter sends; Shift + Enter adds a line. Your selection is
              context; Assist can change the whole current file.
            </>
          ),
        },
        {
          title: "Listen, then decide",
          body: (
            <>
              Edits appear directly in the editor. Press Play / Update to hear
              them, or return to the editor and use <Shortcut command="undo" />{" "}
              to undo. Esc closes Assist.
            </>
          ),
        },
      ],
    },
    {
      id: "modules",
      label: "Connect your ideas",
      icon: Network,
      title: "Small parts. A bigger track.",
      description:
        "Keep a melody, a drum pattern or an instrument in its own file, then combine them in a master snippet.",
      instructions: [
        {
          title: "Bring a voice into the master",
          body: "Drag a snippet from the explorer into the editor. Wien makes it exportable and adds an import. Use the imported name in your pattern, for example stack(keys, drums).",
        },
        {
          title: "Follow the connections",
          body: "Open Graph View at the bottom left. Arrows point from a dependency to the file using it. Double-click a node to open its code; use ⋯ → View in Graph View to find a specific snippet.",
        },
        {
          title: "Update the composition",
          body: "After typing changes in a voice, Update the master to hear them together. The master sets the tempo. Moving or renaming files in the explorer updates their import paths.",
        },
      ],
    },
    {
      id: "save",
      label: "Keep your work",
      icon: History,
      title: "Leave yourself a way back.",
      description: web
        ? "Try Versions here. In the desktop app, save snapshots before an experiment and restore an earlier idea whenever you like."
        : "Your files save automatically. Versions keeps named snapshots so you can always return to an earlier idea.",
      instructions: [
        {
          title: "Save a version",
          body: "Open Versions below the explorer. Give the moment a short name and save it before trying something new. Try naming a new version in the demo above.",
        },
        {
          title: "Return to an earlier idea",
          body: "Select a version to return to its code and listen. Return to working state brings back your latest edits. Try Restore beside a version above to move back through the timeline.",
        },
      ],
      tip: "Git-powered. You can add a remote and push your work to GitHub.",
    },
    {
      id: "wav",
      label: "Save your sound",
      icon: AudioLines,
      title: "Turn a sketch into a track.",
      description: "",
      instructions: [
        {
          title: "Choose ⋯ → Save WAV",
          body: "Use the three-dot menu above the editor, or a file’s menu in the explorer. The export starts at the beginning; other playing tabs are not mixed in.",
        },
        {
          title: "Choose the length",
          body: "Set the number of cycles — usually one cycle is one bar — and leave an effect tail for reverb and delay. For the full Glass Nerve arrangement, choose 96 cycles.",
        },
        {
          title: "Render and save",
          body: web
            ? "Optionally normalize the peak, then click Save WAV. The stereo WAV downloads when rendering finishes. You can cancel a render at any time."
            : "Optionally normalize the peak, then click Save WAV and choose where to save it. If you cancel the file dialog, click Save WAV again without re-rendering.",
        },
      ],
    },
  ];
}
