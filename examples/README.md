# Wien example registry

Every immediate subdirectory is a complete project. **New from example** in the
top-left project menu opens the picker. A selection creates an editable copy under
the example name; only a name collision opens a naming dialog. Desktop creates the
copy next to the current project; web uses browser storage. Existing user projects
are never replaced when bundled examples change.

| Project | Listen / explore |
| --- | --- |
| [default](default/README.md) | **Glass Nerve** — a 96-bar melodic IDM composition with fragile FM keys, detailed broken drums, a drumless middle and a returning theme |
| [control-room](control-room/README.md) | **Memory Console** — the preserved controls-demo melody; every control type, groups, defaults, reset, bounded and detented knobs, serial effects |
| [signal-garden](signal-garden/README.md) | **Signal Garden** — polyrhythmic ambient, nested named/namespace imports, a shared instrument, the graph and independent voices |
| [drum-machines](drum-machines/README.md) | **Machine Room** — offline synth kit, switchable TR808/TR909/Linn samples and an acid voice |
| [live-sketchbook](live-sketchbook/README.md) | **Live Sketchbook** — labelled tracks, background tabs, import/export, Undo, Versions and an Assist exercise |

## Capability map

- **Sound and composition:** deterministic phrases, harmony, separate registers,
  synth/FM/noise voices, envelopes, filters, delay/reverb/orbits, time transformations
  and long-form arrangement. `default` is a track first, not a UI test fixture.
- **Controls:** `control-room` covers numbers, booleans, enums, empty and ordered
  multi-selection, horizontal/vertical sliders, knob step/min/max/split, object
  groups, defaults/reset, settings, hide/Undo and code-as-state.
- **Modules:** `default` and `signal-garden` cover nested, default, named and namespace
  imports, shared `.js` helpers, independent previews and the dependency graph.
- **Workflow:** `live-sketchbook` gives concrete exercises for multi-tab playback,
  edits/Update/autosave, refactoring imports, snapshots, file export and current-file
  Assist. There is no shared beat clock or account-based project sync.
- **Assets:** every project's initial sound works offline. Only the non-Synth bank
  choices in `drum-machines` download audio. Assist separately needs the backend.

## Adding or editing an example

Keep `.strudel` / `.js` files and all relative imports inside its project directory.
A project has one playable root file, which Wien opens automatically (the first
root snippet by name). Put reusable voices in subdirectories. `README.md` describes
what to hear and what to try; it is repository documentation, not a project snippet.

`client/src/shared/examples.ts` discovers and bundles every project at build time;
there is no handwritten file list. `default/` seeds First session and New project.
Rebuild after editing. Unit checks compile the module graphs, query musical events
and validate controls; `pnpm --dir client test:examples` exercises the real picker
in web and desktop. Technical UI smoke tests use their own tiny synthetic fixtures,
so their fixed filenames no longer constrain the music library.

`pnpm --dir client test:example-audio` checks actual live output and renders the
full default arrangement plus representative loops from the other projects with
network requests blocked. It rejects silent, non-finite or clipping output and
saves stereo WAV previews and measurements under `.local/example-previews/`
(ignored by Git). This is signal validation, not an automated musical judgement.
