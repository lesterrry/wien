# Signal Garden

A quiet, deterministic ambient piece. Five notes over three bars and seven notes
over four bars meet every twelve bars, above a slow D/A pedal. This is a playable
project whose dependency graph explains its construction. No sample downloads.

Play **garden.strudel** and pin the master before following its imports.

- `branches/left.strudel` uses a **named import** of the instrument factory.
- `branches/right.strudel` uses a **namespace import** of that same `.js` module.
- Both export a default pattern, so either branch is independently playable.
- `shared/prism.js` exports controls and a function, not a playable pattern.
  Change its waveform/decay/wet from the master panel to hear both branches change.
- `voices/floor.strudel` supplies a separate, slowly moving register.

Open Graph View: two branches converge on one shared module. The shared controls
appear once, not once per import. Rename or move the shared file in the explorer:
Wien rewrites both static imports. Use Go to declaration, return to the master,
and Update after typing. Imports are relative and stay inside the project.

For background playback, stop the master, then play each branch in its own tab.
Tabs keep independent clocks; this is a demonstration of layering and independence,
not automatic beat synchronization. Closing one tab stops only its player.
