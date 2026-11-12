# Import controls playground

Open this directory as a Wien project, or copy `playground.strudel` and the
`playground/` directory into an existing project. Play `playground.strudel`, pin
it as master in Controls, and expand the panel.

The master actually plays its imports: rhythm imports kick and hats; bass and
lead share tone. All seven files appear as independent panels; tone appears
once. The default Synth bank starts without downloads. TR909, TR808 and Linn
load their real samples from the CDN on first use.

- `kickVoice = {kickGain, kickDecay}` groups the kick controls; tone groups the shared controls.
- Turn `kickGain` down to zero to mute the deeply imported kick.
- Change `bassCutoff` or `leadPan` to hear each imported voice change.
- Change the `waveform` enum in tone to change both bass and lead.
- Change the `drumBank` enum in rhythm to switch Synth / TR909 / TR808 / Linn.
- Toggle Crush, Lowpass, Drive and Echo in the lead effects multi-selection.
  Drag selected rows to change the actual serial DSP order. Compare Crush →
  Lowpass (smooth) with Lowpass → Crush (rough). Clear all choices for dry sound.
- Toggle a file's `enabled` switch to mute its part. The master's switch mutes all.
- Use a control's context menu → Go to declaration to open its source.

Keep the master playing while changing imported controls; it updates without
restarting its clock. Hiding a panel only changes the UI, not the sound.
