# Live Sketchbook

A small musical workspace for the editing workflow, not a second controls tutorial.
Start **session.strudel**: three `$:` tracks use importable loops at 102 BPM.
The labelled tracks belong to the root; imported files export plain patterns.

## A short session

1. Play the master. Open `loops/notes.strudel`, pin the master if desired, change
   the phrase and Update the master. A knob edit propagates automatically.
2. Undo the change. Create a desktop **Version** named `before variation`, change
   the phrase again, then audition the version and Return to working state.
   In web, export `.wien.json` instead; Versions are desktop-only.
3. Stop all. Play `loops/pulse.strudel`, then visit another tab: the pulse continues.
   Start `loops/notes.strudel` separately, stop one tab, close the other.
   Each tab has its own clock; this is not a synchronized launch system.
4. Create a new snippet, make it exportable, and drag it from the explorer into
   the master editor. Wien adds the import; explicitly use it in a new `$:` track.
   Do not import `session.strudel` itself: imported labelled tracks are unsupported.
5. Try **Ask Assist** in `loops/chords.strudel`: “Make the voicing more suspended;
   preserve the controls and the tempo.” Select a phrase first to provide context.
   Assist requires an account, remaining allowance, backend and RAG; it edits only
   the current file and does not press Play. Undo restores the previous code.
6. Export the web project and import the `.wien.json` into another browser project,
   or open the desktop project folder. Accounts do not synchronize project files.

The loop files each declare a tempo so they also work alone; imported tempo calls
are suppressed and the master owns the tempo when playing `session.strudel`.
All sounds use built-in synthesis. Save is automatic; a failed code update retains
last successfully playing audio, so experiment with an incomplete expression and
then repair it without restarting the whole workspace.
