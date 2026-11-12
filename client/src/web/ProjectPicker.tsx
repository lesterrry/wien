import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Dialog } from "../renderer/src/components/Dialog/Dialog";
import styles from "./ProjectPicker.module.css";
import type { BrowserProject } from "./projects";

type Choice =
  | { kind: "create"; name: string }
  | { kind: "select"; id: string }
  | { kind: "import"; content: string };
export function pickProject(
  projects: BrowserProject[],
  create: boolean,
): Promise<Choice | null> {
  return new Promise((resolve) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const finish = (choice: Choice | null) => {
      resolve(choice);
      queueMicrotask(() => {
        root.unmount();
        container.remove();
      });
    };
    root.render(<Picker projects={projects} create={create} finish={finish} />);
  });
}

function Picker({
  projects,
  create,
  finish,
}: {
  projects: BrowserProject[];
  create: boolean;
  finish: (choice: Choice | null) => void;
}) {
  const [name, setName] = useState("Untitled session");
  const [error, setError] = useState("");
  return (
    <Dialog
      title={create ? "New project" : "Open project"}
      onClose={() => finish(null)}
    >
      <p className={styles.intro}>Projects are saved in this browser.</p>
      {create ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) finish({ kind: "create", name });
          }}
        >
          <label>
            Project name
            <input
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
          <button className={styles.primary} type="submit">
            Create
          </button>
        </form>
      ) : (
        <>
          <div className={styles.list}>
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => finish({ kind: "select", id: project.id })}
              >
                {project.name}
              </button>
            ))}
          </div>
          <label className={styles.import}>
            Import a Wien project
            <input
              type="file"
              accept=".json,application/json"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                try {
                  if (file.size > 25 * 1024 * 1024)
                    throw new Error("This project is too large.");
                  finish({ kind: "import", content: await file.text() });
                } catch (error) {
                  setError(String(error));
                }
              }}
            />
          </label>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
