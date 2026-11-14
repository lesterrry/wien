import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ControlCustomization } from "../../../../shared/control-customizations";
import {
  type ControlGroup,
  type PanelPreferences,
  readControlTree,
  readPanelPreferences,
} from "../../../../shared/control-tree";
import {
  type Control,
  type ControlChange,
  changeControl,
  configureControl,
  ignoreControl,
  moveControl,
  readControlCustomization,
  readControls,
} from "../../../../shared/controls";
import { type Edit, editSource } from "../../../../shared/modules";
import type { useSnippetSessions } from "../../hooks/useSnippetSessions";
import { message } from "./workspace-utils";

const api = window.workspace;

type Options = Pick<
  ReturnType<typeof useSnippetSessions>,
  "sessions" | "sessionsRef" | "players"
> & {
  projectRoot: string | undefined;
  activePath: string | null;
  flush: () => Promise<void>;
  run: (action: () => Promise<void>) => Promise<void>;
  busyRef: RefObject<boolean>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
};
export function useControlPanel({
  projectRoot,
  activePath,
  sessions,
  sessionsRef,
  players,
  flush,
  run,
  busyRef,
  setBusy,
  setError,
}: Options) {
  const [preferences, setPreferences] = useState<PanelPreferences>({
    pinned: null,
    roots: {},
  });
  const [preferencesProject, setPreferencesProject] = useState<string | null>(
    null,
  );
  const [controlTree, setControlTree] = useState<ControlGroup | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeVersion, setTreeVersion] = useState(0);
  const [controlErrors, setControlErrors] = useState<Record<string, string>>(
    {},
  );
  const controlQueue = useRef(Promise.resolve());
  const controlWrites = useRef(0);
  const liveUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preferencesSave = useRef(Promise.resolve());
  const [controlSettings, setControlSettings] = useState<{
    path: string;
    control: Control;
    initial: ControlCustomization;
  } | null>(null);
  const pendingControlPaths = useRef(new Set<string>());

  function saveForeignEdit(
    path: string,
    transform: (code: string) => Edit | undefined,
  ): Promise<void> {
    controlWrites.current += 1;
    const task = controlQueue.current.then(async () => {
      const open = sessionsRef.current.find(
        (session) => session.document.path === path,
      );
      const code = open ? open.document.code : await api.read(path);
      const edit = transform(code);
      if (!edit) return;
      const next = editSource(code, [edit]);
      if (open) {
        players.current.get(open.id)?.replaceCode(next);
        await flush();
      } else await api.save({ path, content: next, expected: code });
      setTreeVersion((version) => version + 1);
      scheduleLiveUpdate(path);
    });
    const settled = task.finally(() => {
      controlWrites.current -= 1;
      setTreeVersion((version) => version + 1);
    });
    controlQueue.current = settled.catch(() => {});
    return settled;
  }

  function movePanelControl(
    path: string,
    name: string,
    targetName: string,
    placement: "before" | "after",
  ) {
    void saveForeignEdit(path, (code) => {
      const controls = readControls(code).controls;
      if (
        ![name, targetName].every((binding) =>
          controls.some((control) => control.name === binding),
        )
      )
        throw new Error(
          "This control has changed. Refresh the panel before moving it.",
        );
      return moveControl(code, name, targetName, placement);
    })
      .then(() =>
        setControlErrors((current) => {
          const next = { ...current };
          delete next[JSON.stringify([path, name])];
          return next;
        }),
      )
      .catch((error) =>
        setControlErrors((current) => ({
          ...current,
          [JSON.stringify([path, name])]: message(error),
        })),
      );
  }

  const panelRoot = preferences.pinned ?? activePath;
  const panelLayout = (panelRoot && preferences.roots[panelRoot]) || {
    hidden: {},
    collapsed: {},
  };

  useEffect(() => {
    if (!projectRoot) return;
    let cancelled = false;
    const root = projectRoot;
    setPreferencesProject(null);
    setPreferences({ pinned: null, roots: {} });
    setControlErrors({});
    void api
      .readControlPreferences(root)
      .then((saved) => {
        if (!cancelled) {
          setPreferences(saved ?? readPanelPreferences(root));
          setPreferencesProject(root);
        }
      })
      .catch((error) => {
        if (!cancelled) setError(message(error));
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, setError]);

  useEffect(() => {
    if (!projectRoot || preferencesProject !== projectRoot) return;
    let cancelled = false;
    const root = projectRoot;
    const task = preferencesSave.current
      .catch(() => {})
      .then(() => api.saveControlPreferences(root, preferences))
      .then(() => {
        try {
          localStorage.removeItem(`wien:controls:${root}`);
        } catch {
          /* Project settings have already been saved. */
        }
      });
    preferencesSave.current = task;
    void task.catch((error) => {
      if (!cancelled)
        setError(`Could not save panel settings: ${message(error)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, preferences, preferencesProject, setError]);

  const treeRevision = JSON.stringify([
    projectRoot,
    sessions.map((session) => [session.document.path, session.document.code]),
    treeVersion,
  ]);
  useEffect(() => {
    const [, openSources] = JSON.parse(treeRevision) as [
      string | null,
      [string, string][],
      number,
    ];
    const drafts = new Map(openSources);
    let cancelled = false;
    if (!panelRoot) {
      setControlTree(null);
      setTreeLoading(false);
      return;
    }
    setTreeLoading(true);
    const timer = setTimeout(() => {
      void readControlTree(panelRoot, async (path) => {
        return drafts.has(path)
          ? Promise.resolve(drafts.get(path) as string)
          : api.read(path);
      }).then((tree) => {
        if (!cancelled && controlWrites.current === 0) {
          setControlTree(tree);
          setTreeLoading(false);
        }
      });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [panelRoot, treeRevision]);

  function scheduleLiveUpdate(path: string) {
    pendingControlPaths.current.add(path);
    if (liveUpdateTimer.current !== null) return;
    liveUpdateTimer.current = setTimeout(() => {
      liveUpdateTimer.current = null;
      void controlQueue.current
        .then(async () => {
          const changes = [...pendingControlPaths.current];
          pendingControlPaths.current.clear();
          for (const session of sessionsRef.current.filter(
            (session) => session.playback.started,
          )) {
            const running = players.current.get(session.id);
            if (running && changes.some((file) => running.dependsOn(file)))
              await running.update({ flash: false });
          }
        })
        .catch((error) => setError(message(error)));
    }, 60);
  }

  function previewControl(control: Control, change: ControlChange): Control {
    if (change.type === "reset")
      return control.defaultValue === undefined
        ? control
        : previewControl(control, { type: "set", value: control.defaultValue });
    if (change.type === "set")
      return {
        ...control,
        value: change.value,
        ...(control.kind === "enum"
          ? {
              selectedKey:
                control.options.find((option) =>
                  Object.is(option.value, change.value),
                )?.key ?? control.selectedKey,
            }
          : {}),
      } as Control;
    if (control.kind !== "multi-enum") return control;
    const options = change.order.flatMap((key) =>
      control.options.filter((option) => option.key === key),
    );
    return {
      ...control,
      options,
      hasOrder: true,
      value: options
        .filter((option) => control.value.includes(option.value))
        .map((option) => option.value),
    };
  }

  function editPanelControl(
    path: string,
    name: string,
    change?: ControlChange,
  ) {
    const key = JSON.stringify([path, name]);
    // All appearances share an optimistic value, including keyboard gestures
    // whose next step arrives before the file write has finished.
    const updateTree = (group: ControlGroup): ControlGroup => ({
      ...group,
      controls:
        group.path === path
          ? group.controls.flatMap((control) =>
              control.name !== name
                ? [control]
                : change === undefined
                  ? []
                  : [previewControl(control, change)],
            )
          : group.controls,
      children: group.children.map(updateTree),
    });
    setControlTree((tree) => (tree ? updateTree(tree) : null));
    controlWrites.current += 1;
    controlQueue.current = controlQueue.current.then(async () => {
      try {
        const open = sessionsRef.current.find(
          (session) => session.document.path === path,
        );
        const source = open ? open.document.code : await api.read(path);
        const control = readControls(source).controls.find(
          (control) => control.name === name,
        );
        if (
          !control ||
          (change?.type === "reorder" && control.kind !== "multi-enum") ||
          (change?.type === "set" &&
            typeof control.value !== typeof change.value)
        )
          throw new Error(
            "This control has changed. Fix its declaration before editing.",
          );
        const edit =
          change === undefined
            ? ignoreControl(source, name)
            : changeControl(source, name, change);
        if (edit) {
          const code = editSource(source, [edit]);
          if (open) {
            if (change === undefined)
              players.current.get(open.id)?.ignoreControl(name);
            else players.current.get(open.id)?.changeControl(name, change);
            await flush();
          } else await api.save({ path, content: code, expected: source });
        }
        setTreeVersion((version) => version + 1);
        setControlErrors((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        if (change !== undefined) scheduleLiveUpdate(path);
      } catch (error) {
        setControlErrors((current) => ({ ...current, [key]: message(error) }));
      } finally {
        controlWrites.current -= 1;
        setTreeVersion((version) => version + 1);
      }
    });
  }

  function openControlSettings(path: string, name: string) {
    void run(async () => {
      await controlQueue.current;
      const open = sessionsRef.current.find(
        (session) => session.document.path === path,
      );
      const source = open ? open.document.code : await api.read(path);
      const { control, settings } = readControlCustomization(source, name);
      setControlSettings({ path, control, initial: settings });
    });
  }

  async function saveControlSettings(settings: ControlCustomization) {
    if (!controlSettings || busyRef.current)
      throw new Error("The workspace is busy. Try again.");
    const {
      path,
      control: { name },
      initial,
    } = controlSettings;
    busyRef.current = true;
    setBusy(true);
    controlWrites.current += 1;
    const work = controlQueue.current.then(async () => {
      const open = sessionsRef.current.find(
        (session) => session.document.path === path,
      );
      const source = open ? open.document.code : await api.read(path);
      const edit = configureControl(source, name, settings, initial);
      if (open) {
        if (edit) {
          const editor = players.current.get(open.id);
          if (!editor)
            throw new Error("The source editor is not ready. Try again.");
          editor.configureControl(name, settings, initial);
        }
        await flush();
      } else if (edit)
        await api.save({
          path,
          content: editSource(source, [edit]),
          expected: source,
        });
      setControlErrors((current) => {
        const next = { ...current };
        delete next[JSON.stringify([path, name])];
        return next;
      });
      if (edit) scheduleLiveUpdate(path);
    });
    controlQueue.current = work.catch(() => {});
    try {
      await work;
    } finally {
      controlWrites.current -= 1;
      setTreeVersion((version) => version + 1);
      busyRef.current = false;
      setBusy(false);
    }
  }

  function cancelLiveUpdate() {
    if (liveUpdateTimer.current !== null) {
      clearTimeout(liveUpdateTimer.current);
      liveUpdateTimer.current = null;
    }
    pendingControlPaths.current.clear();
  }

  return {
    preferences,
    setPreferences,
    preferencesSave,
    controlTree,
    treeLoading,
    treeVersion,
    setTreeVersion,
    controlErrors,
    setControlErrors,
    controlQueue,
    controlWrites,
    controlSettings,
    setControlSettings,
    panelRoot,
    panelLayout,
    movePanelControl,
    editPanelControl,
    openControlSettings,
    saveControlSettings,
    cancelLiveUpdate,
  };
}
