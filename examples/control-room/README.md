# Memory Console

A compact performance desk for Wien's generated controls. The lead preserves
exactly the two-bar melody from the former `controls-demo` example; the bass,
percussion, voicing and effects arrangement are new. All sounds are synthesized.

Play **memory-console.strudel**, pin it in Controls, and open full controls.

| Try | What it demonstrates |
| --- | --- |
| Master volume | Vertical slider, source edits and automatic saving |
| Melody level | Bounded knob with a fine step |
| Melody rate | Six fixed intervals between 0.5 and 2 via `split=6` |
| Melody phase | Unbounded knob with eight divisions per revolution; shifts rhythm modulo a bar |
| Waveform | `Object.freeze` enum with symbolic values in source |
| Cutoff / pan | Horizontal and vertical sliders; `var` and `let` work like `const` |
| Enabled | Boolean switch, including inside an object group |
| Effects | Multi-selection, saved option order, and **actual serial DSP stages** |
| Rhythm effects | Empty `@multi` still displays its choices; Default is `[]` |
| Reset arrow | `@default` restores values; a single Undo brings the edit back |

Enable **Crush** and **Lowpass**, then drag Crush before/after Lowpass. `.FX(...)`
creates separate processing stages, so the audible result follows that order.
Ordinary repeated filter setters would not demonstrate serial processing.
Clear all effects to hear the dry voice. Reset restores the chosen default set.

The `instrument`, `space`, `console`, `bass` and `rhythm` objects group controls
without duplicating them. Reorder controls within a group, open the gear to change
the presentation or bounds, hide a control and undo. The source is the saved state.
The wheel scrolls the panel; drag or use arrows to edit values.
