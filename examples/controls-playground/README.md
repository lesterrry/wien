# Import controls playground

Open this directory as a Wien project, or copy `playground.strudel` and the
`playground/` directory into an existing project. Play `playground.strudel`, pin
it as master in Controls, and expand the panel.

The master actually plays its imports: rhythm imports kick and hats; bass and
lead share tone. All seven files appear as independent panels; tone appears
once. No samples or network downloads are needed.

- `kickVoice = {kickGain, kickDecay}` groups the kick controls; tone groups the shared controls.
- Turn `kickGain` down to zero to mute the deeply imported kick.
- Change `bassCutoff` or `leadPan` to hear each imported voice change.
- Change `waveform` in tone to change both bass and lead.
- Toggle a file's `enabled` switch to mute its part. The master's switch mutes all.
- Use a control's context menu → Go to declaration to open its source.

Keep the master playing while changing imported controls; it updates without
restarting its clock. Hiding a panel only changes the UI, not the sound.
