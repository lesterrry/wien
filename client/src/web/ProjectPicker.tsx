import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Dialog } from "../renderer/src/components/Dialog/Dialog";
import { t, useLocale } from "../renderer/src/i18n";
import styles from "./ProjectPicker.module.css";
import type { BrowserProject } from "./projects";

type Choice =
  | { kind: "create"; name: string }
  | { kind: "select"; id: string }
  | { kind: "import"; content: string };
export function pickProject(
  projects: BrowserProject[],
  create: boolean,
  initialName = t("Untitled session"),
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
    root.render(
      <Picker
        projects={projects}
        create={create}
        initialName={initialName}
        finish={finish}
      />,
    );
  });
}

function Picker({
  projects,
  create,
  initialName,
  finish,
}: {
  projects: BrowserProject[];
  create: boolean;
  initialName: string;
  finish: (choice: Choice | null) => void;
}) {
  useLocale();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState("");
  return (
    <Dialog
      title={create ? t("New project") : t("Open project")}
      onClose={() => finish(null)}
    >
      <p className={styles.intro}>{t("Projects are saved in this browser.")}</p>
      {create ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (projects.some((project) => project.name === name.trim())) {
              setError(
                "A project with this name already exists. Choose another name.",
              );
              return;
            }
            if (name.trim()) finish({ kind: "create", name });
          }}
        >
          <label>
            {t("Project name")}
            <input
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
          <button className={styles.primary} type="submit">
            {t("Create")}
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
            {t("Import a Wien project")}
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
                  setError(
                    error instanceof Error ? error.message : String(error),
                  );
                }
              }}
            />
          </label>
        </>
      )}
      {error && <p role="alert">{t(error)}</p>}
    </Dialog>
  );
}
