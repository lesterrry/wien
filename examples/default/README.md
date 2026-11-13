# Glass Nerve

An original piece of melodic IDM: a fragile FM-key phrase against cut-up,
weighty drums, suspended chords and little metallic replies. The form matters
as much as the sound: the drums disappear in the middle and the theme returns
with a different weight.

The keys have deliberate strong and weak attacks. In the fractured sections,
the snare arrives a sixteenth early, tiny noise rolls answer it, and every eighth
bar ends with a falling roll and a whole beat of drum silence. The middle stretches
the theme and its harmony together, giving the return a clear change of scale.

Open **glass-nerve.strudel** and press **Play**. At 148 BPM, one cycle is one
4/4 bar: the 96-bar arrangement lasts about 2:36 before returning to the start.
All voices are synthesized; no audio downloads are required.

| Bars (from 1) | Scene |
| --- | --- |
| 1–8 | Keys, chords and a skeletal pulse; the theme is audible immediately |
| 9–24 | Full broken groove and bass |
| 25–40 | Fractured rhythm and upper-register replies |
| 41–56 | Weightless: no kick or bass, slower keys and drifting air |
| 57–64 | Pulse and bass return |
| 65–80 | Full theme with the answering voice |
| 81–88 | Final fracture |
| 89–96 | Afterimage; the loop returns gently to the opening |

## Play the piece

- Pin the master in **Controls** and expand the panel. `scene` lets you stay in
  Groove, Fracture or Weightless while exploring; Journey restores the full form.
- `volume` controls the output without replacing the relative voice gains.
- `voices/keys.strudel`: `glass` changes the FM edge, `level` changes the foreground.
- `shared/colour.js`: `softness` and `space` affect both keys and chords. It is
  loaded once and appears as one control card despite both imports.
- `drums/kick.strudel`: adjust punch and tail independently of the break.
- `drums/metal.strudel`: raise ticks or shuffle gently, then Reset the controls.
- Turn off `drums/breaks.strudel` to remove the rhythmic spine in every scene.
- **Graph View** reveals the nested drums and shared colour dependency. Click a
  control name to visit its declaration; the pinned master keeps playing.

Numeric controls have useful bounds and explicit defaults. Changing a control
updates the playing master without restarting its clock; typing needs **Update**.
A different BPM changes duration; the key delay is intentionally a fixed short echo.
