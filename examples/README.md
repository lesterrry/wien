# Example projects

Each immediate subdirectory is a self-contained Wien project. Its name is the
project ID in the registry. Keep snippets (`.strudel` or `.js`) and their relative
imports inside that directory; nested folders are preserved. A project should
have a playable file at its root. Wien opens the first root snippet by name.

| Directory | Project |
| --- | --- |
| `default/` | First session: controls demo, a composition with an imported instrument, and two sketches |
| `controls-playground/` | Nested imports, shared controls and switchable drum banks |
| `breakbeat-130/` | Synthesized breakbeat at 130 BPM |
| `razor-break/` | Jungle / breakcore with adjustable tempo and drum levels |

`default/` supplies the files for the first session and every new project in
both desktop and web. Existing projects are kept as they are. The desktop app
copies these files to its project directory; the web app stores them in IndexedDB.

The registry in `client/src/shared/examples.ts` discovers all project snippets
at build time and embeds their source text in the app. There is no separate
snippet list or generated source file to maintain. To add a project, create
another directory here; to change the initial project, edit `default/`. Rebuild
the app to include changes. README files are documentation, not project snippets.

To load any example, open the project menu in the top left, click
**New from example**, and select a project in the dialog. The example name is used automatically: desktop creates
the project next to the current project; web saves it in browser storage.
If that name is already taken, Wien asks for another name. Each selection creates
an editable copy, preserving existing projects and the bundled example. On desktop you can
also open an example directory directly as a project.
