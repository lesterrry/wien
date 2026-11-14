# Machine Room

A shuffling drum-machine / acid study at 126 BPM. Play **machine-room.strudel**.
The default **Synth** kit is built from oscillators and noise and works offline.

In `parts/drums.strudel`, change `drumBank`:

| Choice | Source |
| --- | --- |
| Synth | Local synthesized kick, snare and hats |
| TR808 | Bundled map for `RolandTR808` |
| TR909 | Bundled map for `RolandTR909` |
| Linn | Bundled map for `AkaiLinn` |

Sample audio is fetched from the configured CDN on first use. Those three options
need a network connection; select Synth for offline playback. No custom
`samples(...)` setup is required. This example does not claim to bundle the audio.

The drum voices keep separate levels when switching banks. Turn down the kick
before comparing kits, and reset to the documented defaults afterwards. `swing`
shifts subdivisions while retaining the four-on-floor anchor. The acid voice has
independent cutoff, resonance, level and mute controls, in its own imported panel.

Use the master pin to edit the acid controls while the whole composition runs.
