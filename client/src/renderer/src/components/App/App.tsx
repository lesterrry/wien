import type { ReplState } from "@strudel/codemirror";
import classNames from "classnames";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  Code2,
  FileCode2,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Loader2,
  MoreHorizontal,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ControlGroup,
  type PanelPreferences,
  readControlTree,
  readPanelPreferences,
} from "../../../../shared/control-tree";
import {
  changeControl,
  ignoreControl,
  moveControl,
  readControls,
} from "../../../../shared/controls";
import { type Edit, editSource, hasExports } from "../../../../shared/modules";
import {
  type Entry,
  isWithin,
  joinPath,
  type Project,
  parentPath,
} from "../../../../shared/types";
import { ControllerPanel } from "../ControllerPanel/ControllerPanel";
import { ControlsPanel } from "../ControlsPanel/ControlsPanel";
import { Dialog } from "../Dialog/Dialog";
import { Explorer } from "../Explorer/Explorer";
import { FileTabs } from "../FileTabs/FileTabs";
import { type Player, StrudelEditor } from "../StrudelEditor/StrudelEditor";
import styles from "./App.module.css";

interface Document {
  path: string;
  code: string;
  saved: string;
}
type Modal =
  | { kind: "create"; parent: string; folder: boolean }
  | { kind: "rename"; entry: Entry }
  | { kind: "move"; entry: Entry }
  | { kind: "delete"; entry: Entry }
  | { kind: "reload" }
  | { kind: "help" };

const api = window.workspace;
function findEntry(entries: Entry[], path: string): Entry | undefined {
  for (const entry of entries) {
    if (entry.id === path) return entry;
    if (entry.children) {
      const found = findEntry(entry.children, path);
      if (found) return found;
    }
  }
}
function markExports(
  entries: Entry[],
  path: string,
  exported: boolean,
): Entry[] {
  return entries.map((entry) =>
    entry.id === path
      ? { ...entry, exported }
      : entry.children
        ? { ...entry, children: markExports(entry.children, path, exported) }
        : entry,
  );
}
const message = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );

export function App() {
  const [editorVersion, setEditorVersion] = useState(0);
  const [editors, setEditors] = useState<Record<string, Document>>({});
  const players = useRef(new Map<string, Player>());
  const playingPath = useRef<string | null>(null);
  const [playingFile, setPlayingFile] = useState<string | null>(null);
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
  const navigationBack = useRef(new Map<string, string>());
  const [definitionTarget, setDefinitionTarget] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [document, setDocument] = useState<Document | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const tabsRef = useRef<string[]>([]);
  const documentRef = useRef<Document | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const player = useRef<Player | null>(null);
  const [playback, setPlayback] = useState<ReplState>({
    started: false,
    pending: false,
  });
  const [savedStatus, setSavedStatus] = useState("Saved locally");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [selection, setSelection] = useState<Entry | null>(null);
  const [search, setSearch] = useState("");
  const [sidebar, setSidebar] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [projectMenu, setProjectMenu] = useState(false);
  const [context, setContext] = useState<{
    entry: Entry;
    x: number;
    y: number;
  } | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [value, setValue] = useState("");
  const [modalError, setModalError] = useState<string | null>(null);
  const [position, setPosition] = useState([1, 1]);
  const [controllerOpen, setControllerOpen] = useState(false);

  const updateTabs = useCallback((next: string[]) => {
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const updateDocument = useCallback(
    (next: Document | null) => {
      documentRef.current = next;
      setDocument(next);
      if (next) setEditors((current) => ({ ...current, [next.path]: next }));
      if (next && !tabsRef.current.includes(next.path))
        updateTabs([...tabsRef.current, next.path]);
    },
    [updateTabs],
  );

  const flush = useCallback(async () => {
    if (saving.current) return saving.current;
    const work = async () => {
      while (
        documentRef.current &&
        documentRef.current.code !== documentRef.current.saved
      ) {
        const snapshot = { ...documentRef.current };
        setSavedStatus("Saving…");
        try {
          await api.save({
            path: snapshot.path,
            content: snapshot.code,
            expected: snapshot.saved,
          });
          const current = documentRef.current;
          if (current?.path === snapshot.path)
            updateDocument({ ...current, saved: snapshot.code });
          setProject((currentProject) =>
            currentProject
              ? {
                  ...currentProject,
                  entries: markExports(
                    currentProject.entries,
                    snapshot.path,
                    hasExports(snapshot.code),
                  ),
                }
              : currentProject,
          );
        } catch (error) {
          setSavedStatus("Not saved");
          throw error;
        }
      }
      setSavedStatus("Saved locally");
    };
    saving.current = work();
    try {
      await saving.current;
    } finally {
      saving.current = null;
    }
  }, [updateDocument]);

  const run = useCallback(async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      setError(message(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const activateFile = useCallback(
    async (path: string) => {
      await controlQueue.current;
      await flush();
      const code = await api.read(path);
      players.current.get(path)?.replaceCode(code);
      player.current = players.current.get(path) ?? null;
      setPosition([1, 1]);
      updateDocument({ path, code, saved: code });
      setSavedStatus("Saved locally");
    },
    [flush, updateDocument],
  );

  const openFile = useCallback(
    async (path: string) => {
      if (documentRef.current?.path === path) return;
      await run(() => activateFile(path));
    },
    [activateFile, run],
  );

  const closeTab = useCallback(
    async (path: string) => {
      await run(async () => {
        await controlQueue.current;
        const index = tabsRef.current.indexOf(path);
        if (index < 0) return;
        const remaining = tabsRef.current.filter((item) => item !== path);
        if (playingPath.current === path) {
          await players.current.get(path)?.stop();
          playingPath.current = null;
          setPlayingFile(null);
          setPlayback({ started: false, pending: false });
        }
        if (documentRef.current?.path === path) {
          await flush();
          const previous = navigationBack.current.get(path);
          const next =
            previous && remaining.includes(previous)
              ? previous
              : remaining[Math.min(index, remaining.length - 1)];
          navigationBack.current.delete(path);
          if (next) await activateFile(next);
          else {
            player.current = null;
            updateDocument(null);
          }
        }
        updateTabs(remaining);
      });
    },
    [activateFile, flush, run, updateDocument, updateTabs],
  );

  function saveForeignEdit(
    path: string,
    transform: (code: string) => Edit | undefined,
  ): Promise<void> {
    controlWrites.current += 1;
    const task = controlQueue.current.then(async () => {
      const active = documentRef.current;
      const code = active?.path === path ? active.code : await api.read(path);
      const edit = transform(code);
      if (!edit) return;
      const next = editSource(code, [edit]);
      if (active?.path === path) {
        player.current?.replaceCode(next);
        await flush();
      } else {
        await api.save({ path, content: next, expected: code });
        players.current.get(path)?.replaceCode(next);
        setEditors((current) =>
          current[path]
            ? { ...current, [path]: { path, code: next, saved: next } }
            : current,
        );
      }
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

  function saveForeign(
    path: string,
    name: string,
    value: number | boolean,
  ): Promise<void> {
    return saveForeignEdit(path, (code) => changeControl(code, name, value));
  }

  function saveForeignMove(
    path: string,
    name: string,
    targetName: string,
    placement: "before" | "after",
  ): Promise<void> {
    return saveForeignEdit(path, (code) =>
      moveControl(code, name, targetName, placement),
    );
  }

  function movePanelControl(
    path: string,
    name: string,
    targetName: string,
    placement: "before" | "after",
  ) {
    void saveForeignMove(path, name, targetName, placement).catch((error) =>
      setControlErrors((current) => ({
        ...current,
        [JSON.stringify([path, name])]: message(error),
      })),
    );
  }

  useEffect(() => {
    void api
      .current()
      .then(async (project) => {
        setProject(project);
        const first = project.entries.find((entry) => !entry.children);
        if (first) {
          const code = await api.read(first.id);
          updateDocument({ path: first.id, code, saved: code });
        }
      })
      .catch((error) => setError(message(error)));
  }, [updateDocument]);

  useEffect(() => {
    if (!document || document.code === document.saved) return;
    const timer = setTimeout(() => {
      void flush().catch((error) => setError(message(error)));
    }, 650);
    return () => clearTimeout(timer);
  }, [document, flush]);

  useEffect(() => {
    const protectPendingEdits = (event: BeforeUnloadEvent) => {
      const current = documentRef.current;
      if (!current || current.code === current.saved) return;
      event.preventDefault();
      event.returnValue = "";
      void flush().catch((error) => setError(message(error)));
    };
    window.addEventListener("beforeunload", protectPendingEdits);
    return () =>
      window.removeEventListener("beforeunload", protectPendingEdits);
  }, [flush]);

  useEffect(
    () =>
      api.onBeforeClose(() => {
        if (busyRef.current) {
          api.cancelClose();
          return;
        }
        void run(async () => {
          try {
            await controlQueue.current;
            await flush();
            if (playingPath.current)
              await players.current.get(playingPath.current)?.stop();
            api.finishClose();
          } catch (error) {
            api.cancelClose();
            throw error;
          }
        });
      }),
    [flush, run],
  );

  const play = useCallback(() => {
    void run(async () => {
      await controlQueue.current;
      await flush();
      const path = documentRef.current?.path;
      if (!path) return;
      if (playingPath.current && playingPath.current !== path)
        await players.current.get(playingPath.current)?.stop();
      playingPath.current = path;
      setPlayingFile(path);
      await players.current.get(path)?.play();
    });
  }, [flush, run]);
  const stop = useCallback(() => {
    if (playingPath.current)
      void players.current.get(playingPath.current)?.stop();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "," || event.code === "Comma") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && !busyRef.current && !modal)
          player.current?.assist();
        return;
      }
      if (
        event.target instanceof Element &&
        event.target.closest("[data-assistant]") &&
        event.key === "Enter"
      )
        return;
      if (event.key === "w") {
        event.preventDefault();
        event.stopPropagation();
        if (documentRef.current) void closeTab(documentRef.current.path);
        else api.close();
      }
      if (event.key === "s") {
        event.preventDefault();
        void flush().catch((error) => setError(message(error)));
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        play();
      }
      if (event.key === ".") {
        event.preventDefault();
        event.stopPropagation();
        stop();
      }
      if (event.key === "b") {
        event.preventDefault();
        setSidebar((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeTab, flush, play, stop, modal]);

  useEffect(() => {
    if (!context && !projectMenu) return;
    const close = () => {
      setContext(null);
      setProjectMenu(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [context, projectMenu]);

  useEffect(() => {
    if (!document) setControllerOpen(false);
  }, [document]);

  function showModal(next: Modal) {
    setContext(null);
    setModalError(null);
    setValue(
      next.kind === "rename"
        ? next.entry.name
        : next.kind === "create"
          ? next.folder
            ? "New folder"
            : "untitled.strudel"
          : "",
    );
    setModal(next);
  }

  async function refresh() {
    setProject(await api.current());
    setTreeVersion((version) => version + 1);
  }

  async function syncDocument() {
    const current = documentRef.current;
    if (!current) return;
    const code = await api.read(current.path);
    if (code !== current.code) player.current?.replaceCode(code);
    updateDocument({ ...current, code, saved: code });
    setSavedStatus("Saved locally");
  }

  async function toggleExport(file: string) {
    setContext(null);
    await run(async () => {
      await flush();
      await api.toggleExport(file);
      await syncDocument();
      await refresh();
    });
  }

  async function linkSnippet(source: string) {
    await run(async () => {
      const target = documentRef.current?.path;
      if (!target) return;
      await flush();
      await api.link(source, target);
      await syncDocument();
      await refresh();
    });
  }

  async function move(from: string, to: string) {
    await controlQueue.current;
    await flush();
    if (playingPath.current)
      await players.current.get(playingPath.current)?.stop();
    playingPath.current = null;
    setPlayingFile(null);
    setPlayback({ started: false, pending: false });
    await api.move(from, to);
    updateTabs(
      tabsRef.current.map((file) =>
        isWithin(file, from) ? to + file.slice(from.length) : file,
      ),
    );
    const current = documentRef.current;
    if (current && isWithin(current.path, from)) {
      updateDocument({
        ...current,
        path: to + current.path.slice(from.length),
      });
    }
    setSelection(null);
    await syncDocument();
    await refresh();
  }

  async function switchProject(create: boolean) {
    await run(async () => {
      await controlQueue.current;
      await flush();
      const next = await (create ? api.create() : api.open());
      if (!next) return;
      if (playingPath.current)
        await players.current.get(playingPath.current)?.stop();
      updateTabs([]);
      updateDocument(null);
      setPlayback({ started: false, pending: false });
      playingPath.current = null;
      setPlayingFile(null);
      setEditors({});
      setProject(next);
      setSearch("");
      setSelection(null);
      const first = next.entries.find((entry) => !entry.children);
      if (first) {
        const code = await api.read(first.id);
        updateDocument({ path: first.id, code, saved: code });
      }
    });
  }

  async function submitModal() {
    if (!modal || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setModalError(null);
    try {
      await controlQueue.current;
      if (modal.kind === "create") {
        await flush();
        const path = await api.add(modal.parent, value, modal.folder);
        await refresh();
        if (!modal.folder) {
          await player.current?.stop();
          const code = await api.read(path);
          updateDocument({ path, code, saved: code });
        }
      } else if (modal.kind === "reload") {
        const current = documentRef.current;
        if (current) {
          const code = await api.read(current.path);
          await player.current?.stop();
          updateDocument({ path: current.path, code, saved: code });
          setEditorVersion((version) => version + 1);
          setPlayback({ started: false, pending: false });
          setSavedStatus("Saved locally");
          setError(null);
        }
      } else if (modal.kind === "rename") {
        if (value.includes("/"))
          throw new Error("Enter a name without slashes.");
        await move(modal.entry.id, joinPath(parentPath(modal.entry.id), value));
      } else if (modal.kind === "move") {
        await move(modal.entry.id, joinPath(value, modal.entry.name));
      } else if (modal.kind === "delete") {
        await flush();
        if (playingPath.current)
          await players.current.get(playingPath.current)?.stop();
        playingPath.current = null;
        setPlayingFile(null);
        setPlayback({ started: false, pending: false });
        await api.trash(modal.entry.id);
        const remaining = tabsRef.current.filter(
          (file) => !isWithin(file, modal.entry.id),
        );
        updateTabs(remaining);
        if (
          documentRef.current &&
          isWithin(documentRef.current.path, modal.entry.id)
        ) {
          await player.current?.stop();
          updateDocument(null);
          setPlayback({ started: false, pending: false });
          if (remaining.length) await activateFile(remaining[0]);
        }
        setSelection(null);
        await refresh();
      }
      setModal(null);
    } catch (error) {
      setModalError(message(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const destination = selection?.children
    ? selection.id
    : selection
      ? parentPath(selection.id)
      : "";
  const filename = document?.path.split("/").at(-1);
  const dirty = document?.code !== document?.saved;
  const folders = (entries: Entry[]): Entry[] =>
    entries.flatMap((entry) =>
      entry.children ? [entry, ...folders(entry.children)] : [],
    );
  const shortcut = navigator.platform.includes("Mac") ? "⌘" : "Ctrl";
  const panelRoot = preferences.pinned ?? document?.path ?? null;
  const panelLayout = (panelRoot && preferences.roots[panelRoot]) || {
    hidden: {},
    collapsed: {},
  };

  useEffect(() => {
    if (!project?.root) return;
    setPreferences(readPanelPreferences(project.root));
    setPreferencesProject(project.root);
    setControlErrors({});
  }, [project?.root]);

  useEffect(() => {
    if (!project || preferencesProject !== project.root) return;
    try {
      localStorage.setItem(
        `wien:controls:${project.root}`,
        JSON.stringify(preferences),
      );
    } catch (error) {
      setError(`Could not save panel settings: ${message(error)}`);
    }
  }, [project, preferences, preferencesProject]);

  const treeRevision = JSON.stringify([
    project?.root,
    document?.path,
    document?.code,
    treeVersion,
  ]);
  useEffect(() => {
    const [, activePath, activeCode] = JSON.parse(treeRevision) as [
      string | null,
      string | null,
      string | null,
      number,
    ];
    let cancelled = false;
    if (!panelRoot) {
      setControlTree(null);
      setTreeLoading(false);
      return;
    }
    setTreeLoading(true);
    const timer = setTimeout(() => {
      void readControlTree(panelRoot, async (path) => {
        return activePath === path && activeCode !== null
          ? activeCode
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
    const playing = playingPath.current;
    const running = playing ? players.current.get(playing) : undefined;
    if (
      !playing ||
      !running?.dependsOn(path) ||
      liveUpdateTimer.current !== null
    )
      return;
    liveUpdateTimer.current = setTimeout(() => {
      liveUpdateTimer.current = null;
      void controlQueue.current
        .then(async () => {
          if (
            playingPath.current === playing &&
            players.current.get(playing) === running
          )
            await running.update();
        })
        .catch((error) => setError(message(error)));
    }, 60);
  }

  function editPanelControl(
    path: string,
    name: string,
    value?: number | boolean,
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
                : value === undefined
                  ? []
                  : [{ ...control, value } as typeof control],
            )
          : group.controls,
      children: group.children.map(updateTree),
    });
    setControlTree((tree) => (tree ? updateTree(tree) : null));
    controlWrites.current += 1;
    controlQueue.current = controlQueue.current.then(async () => {
      try {
        const current = documentRef.current;
        const source =
          current?.path === path ? current.code : await api.read(path);
        if (
          !readControls(source).controls.some(
            (control) => control.name === name,
          )
        )
          throw new Error(
            "This control has changed. Fix its declaration before editing.",
          );
        if (current?.path === path) {
          if (value === undefined) player.current?.ignoreControl(name);
          else player.current?.changeControl(name, value);
          await flush();
        } else {
          const edit =
            value === undefined
              ? ignoreControl(source, name)
              : changeControl(source, name, value);
          if (edit) {
            const code = editSource(source, [edit]);
            await api.save({ path, content: code, expected: source });
            players.current.get(path)?.replaceCode(code);
            setEditors((current) =>
              current[path]
                ? { ...current, [path]: { path, code, saved: code } }
                : current,
            );
          }
        }
        setTreeVersion((version) => version + 1);
        setControlErrors((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        if (value !== undefined) scheduleLiveUpdate(path);
      } catch (error) {
        setControlErrors((current) => ({ ...current, [key]: message(error) }));
      } finally {
        controlWrites.current -= 1;
        setTreeVersion((version) => version + 1);
      }
    });
  }

  function goToControl(path: string, name: string) {
    void run(async () => {
      await controlQueue.current;
      const previous = documentRef.current?.path;
      if (previous !== path) {
        if (previous) navigationBack.current.set(path, previous);
        await activateFile(path);
      }
      setDefinitionTarget({ path, name });
    });
  }

  // Child editor effects register the player before this effect runs, including
  // when navigation opens a new tab rather than revealing an existing editor.
  useEffect(() => {
    if (definitionTarget && document?.path === definitionTarget.path) {
      players.current
        .get(definitionTarget.path)
        ?.revealControl(definitionTarget.name);
    }
  }, [definitionTarget, document?.path]);

  return (
    <div
      className={classNames(styles.app, {
        [styles.sidebarHidden]: !sidebar,
        [styles.controlsHidden]: !controlsVisible || controllerOpen,
      })}
    >
      <div className={styles.titlebar}>
        <div className={styles.titlebarSidebar}>
          <span className={styles.appName}>
            wien<span className={styles.wordmarkDot}>.</span>
          </span>
          <button
            className={styles.iconButton}
            type="button"
            title={`Toggle sidebar (${shortcut} B)`}
            aria-label="Toggle sidebar"
            onClick={() => setSidebar(!sidebar)}
          >
            {sidebar ? (
              <PanelLeftClose size={17} />
            ) : (
              <PanelLeftOpen size={17} />
            )}
          </button>
        </div>
        <div className={styles.titlebarMain}>
          <FileTabs
            tabs={tabs.map((path) => ({
              path,
              exported:
                path === document?.path
                  ? hasExports(document.code)
                  : Boolean(findEntry(project?.entries ?? [], path)?.exported),
              dirty:
                path === document?.path && document.code !== document.saved,
            }))}
            active={document?.path ?? null}
            disabled={busy}
            onSelect={(path) => {
              setControllerOpen(false);
              void openFile(path);
            }}
            onClose={(path) => void closeTab(path)}
            controller={{
              open: controllerOpen,
              disabled: busy,
              onSelect: () => {},
              onClose: () => setControllerOpen(false),
            }}
          />
          <button
            type="button"
            className={styles.iconButton}
            title="Toggle controls"
            aria-label="Toggle controls"
            aria-expanded={controlsVisible}
            onClick={() => setControlsVisible(!controlsVisible)}
          >
            {controlsVisible ? (
              <PanelRightClose size={17} />
            ) : (
              <PanelRightOpen size={17} />
            )}
          </button>
        </div>
      </div>

      {sidebar && (
        <aside className={styles.sidebar}>
          <div className={styles.projectPickerWrap}>
            <button
              className={styles.projectPicker}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setProjectMenu(!projectMenu);
              }}
              disabled={busy}
            >
              <span className={styles.projectAvatar}>
                <Code2 size={18} />
              </span>
              <span>
                <strong>{project?.name ?? "Opening workspace…"}</strong>
                <small>Personal project</small>
              </span>
              <ChevronDown size={14} />
            </button>
            {projectMenu && (
              <div className={classNames(styles.menu, styles.projectMenu)}>
                <button type="button" onClick={() => void switchProject(true)}>
                  <Plus size={15} />
                  New project
                </button>
                <button type="button" onClick={() => void switchProject(false)}>
                  <FolderOpen size={15} />
                  Open project…
                </button>
                <div className={styles.menuDivider} />
                <button
                  type="button"
                  onClick={() =>
                    void api.reveal().catch((error) => setError(message(error)))
                  }
                >
                  <ArrowRight size={15} />
                  Show project folder
                </button>
              </div>
            )}
          </div>
          <label className={styles.searchBox}>
            <Search size={14} />
            <input
              aria-label="Find a snippet"
              placeholder="Find a snippet…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search && (
              <button
                className={styles.iconButton}
                type="button"
                aria-label="Clear search"
                onClick={() => setSearch("")}
              >
                <X size={12} />
              </button>
            )}
          </label>
          <div className={styles.sectionHeading}>
            <span>Files</span>
            <div>
              <button
                className={styles.iconButton}
                type="button"
                title="Refresh files"
                aria-label="Refresh files"
                disabled={busy}
                onClick={() => void run(refresh)}
              >
                <RefreshCw size={13} />
              </button>
              <button
                className={styles.iconButton}
                type="button"
                title="New snippet"
                aria-label="New snippet"
                disabled={busy}
                onClick={() =>
                  showModal({
                    kind: "create",
                    parent: destination,
                    folder: false,
                  })
                }
              >
                <FilePlus2 size={15} />
              </button>
              <button
                className={styles.iconButton}
                type="button"
                title="New folder"
                aria-label="New folder"
                disabled={busy}
                onClick={() =>
                  showModal({
                    kind: "create",
                    parent: destination,
                    folder: true,
                  })
                }
              >
                <FolderPlus size={15} />
              </button>
            </div>
          </div>
          <Explorer
            entries={
              document
                ? markExports(
                    project?.entries ?? [],
                    document.path,
                    hasExports(document.code),
                  )
                : (project?.entries ?? [])
            }
            selected={document?.path ?? null}
            search={search}
            disabled={busy}
            onOpen={(path) => void openFile(path)}
            onSelect={setSelection}
            onRename={(path, name) =>
              run(() => move(path, joinPath(parentPath(path), name)))
            }
            onMove={(paths, parent) =>
              run(async () => {
                for (const path of paths)
                  await move(
                    path,
                    joinPath(parent, path.split("/").at(-1) ?? path),
                  );
              })
            }
            onMenu={(entry, x, y) =>
              setContext({
                entry,
                x: Math.min(x, window.innerWidth - 210),
                y: Math.min(y, window.innerHeight - 225),
              })
            }
          />
          <div className={styles.sidebarBottom}>
            <button
              type="button"
              className={styles.localProject}
              onClick={() =>
                void api.reveal().catch((error) => setError(message(error)))
              }
              title={project?.root}
            >
              <HardDrive size={16} />
              <span>
                On your computer<small>Changes save automatically</small>
              </span>
              <ArrowRight size={13} />
            </button>
            <button
              type="button"
              className={styles.helpButton}
              onClick={() => showModal({ kind: "help" })}
            >
              <CircleHelp size={14} />
              Getting started<span>?</span>
            </button>
          </div>
        </aside>
      )}

      <main
        className={styles.workspace}
        id="snippet-panel"
        role="tabpanel"
        aria-labelledby={
          document ? `tab-${encodeURIComponent(document.path)}` : undefined
        }
        aria-label={document ? undefined : "Snippet editor"}
      >
        <header
          className={styles.editorToolbar}
          role="toolbar"
          aria-label="Snippet toolbar"
        >
          <div className={styles.fileHeading}>
            {document ? (
              <>
                {controllerOpen ? (
                  <SlidersHorizontal size={17} />
                ) : hasExports(document.code) ? (
                  <Package size={17} />
                ) : (
                  <FileCode2 size={17} />
                )}
                <div>
                  <strong>{filename}</strong>
                  <span>
                    {project?.name}
                    {parentPath(document.path)
                      ? ` / ${parentPath(document.path)}`
                      : ""}
                  </span>
                </div>
              </>
            ) : (
              <span className={styles.muted}>Your next idea starts here</span>
            )}
          </div>
          <div className={styles.transport}>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Ask Wien"
              title={`Ask Wien (${shortcut} ,)`}
              disabled={!document || busy}
              onClick={() => player.current?.assist("bottom")}
            >
              <Sparkles size={16} />
            </button>
            <button
              type="button"
              className={classNames(styles.iconButton, styles.stopButton)}
              title={`Stop (${shortcut} .)`}
              aria-label="Stop playback"
              disabled={!playback.started}
              onClick={stop}
            >
              <Square size={14} fill="currentColor" />
            </button>
            <button
              type="button"
              className={styles.playButton}
              disabled={!document || playback.pending || busy}
              onClick={play}
            >
              {playback.pending ? (
                <Loader2 size={14} className={styles.spin} />
              ) : (
                <Play size={13} fill="currentColor" />
              )}
              <span>
                {playback.started && playingFile === document?.path
                  ? "Update"
                  : "Play"}
              </span>
              <kbd>{shortcut} ↵</kbd>
            </button>
            {controllerOpen && document ? (
              <button
                type="button"
                className={styles.closeButton}
                title="Close controls"
                aria-label="Close controls"
                onClick={() => setControllerOpen(false)}
              >
                <X size={15} />
              </button>
            ) : (
              <button
                type="button"
                className={styles.iconButton}
                title="Snippet actions"
                aria-label="Snippet actions"
                disabled={!document || busy}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!document) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  setContext({
                    entry: {
                      id: document.path,
                      name: filename ?? document.path,
                      exported: hasExports(document.code),
                    },
                    x: rect.right - 220,
                    y: rect.bottom + 8,
                  });
                }}
              >
                <MoreHorizontal size={18} />
              </button>
            )}
          </div>
        </header>
        {error && (
          <div role="alert" className={styles.errorBanner}>
            <span>{error}</span>
            {savedStatus === "Not saved" && (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => showModal({ kind: "reload" })}
              >
                Reload file…
              </button>
            )}
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Dismiss error"
              onClick={() => setError(null)}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {tabs
          .filter((path) => editors[path])
          .map((path) => (
            <div
              key={`${project?.root}/${path}/${editorVersion}`}
              className={styles.editorSession}
              data-active={document?.path === path}
              style={{
                display:
                  !controllerOpen && document?.path === path ? "flex" : "none",
              }}
            >
              <StrudelEditor
                initialCode={editors[path].code}
                path={path}
                disabled={busy || document?.path !== path || controllerOpen}
                onLink={(source) => void linkSnippet(source)}
                onChange={(code) => {
                  const current = documentRef.current;
                  if (current?.path === path) {
                    updateDocument({ ...current, code });
                    setSavedStatus("Unsaved changes");
                  }
                }}
                onState={(state) => {
                  if (playingPath.current === path) setPlayback(state);
                }}
                onReady={(next) => {
                  if (next) players.current.set(path, next);
                  else {
                    players.current.delete(path);
                    if (playingPath.current === path) {
                      playingPath.current = null;
                      setPlayingFile(null);
                      setPlayback({ started: false, pending: false });
                    }
                  }
                  if (documentRef.current?.path === path) player.current = next;
                }}
                onPosition={(line, column) => {
                  if (documentRef.current?.path === path)
                    setPosition([line, column]);
                }}
              />
            </div>
          ))}
        {!document && (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <Code2 size={30} strokeWidth={1.2} />
            </div>
            <h1>Make room for a little music.</h1>
            <p>
              Open a snippet, or start with a few notes.
              <br />
              There’s no wrong place to begin.
            </p>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() =>
                showModal({ kind: "create", parent: "", folder: false })
              }
            >
              <Plus size={15} />
              New snippet
            </button>
          </div>
        )}
        {controllerOpen && document && (
          <ControllerPanel
            document={document}
            playback={playback}
            disabled={busy}
            onChange={(name, value) =>
              editPanelControl(document.path, name, value)
            }
            onMove={(name, targetName, placement) =>
              movePanelControl(document.path, name, targetName, placement)
            }
            onForeignChange={saveForeign}
            onForeignMove={saveForeignMove}
            onError={setError}
          />
        )}
        {playback.error && (
          <div className={styles.evaluationError} role="alert">
            <strong>Couldn’t run this code</strong>
            <span>{playback.error.message}</span>
            {playback.started && (
              <small>The previous version is still playing.</small>
            )}
          </div>
        )}
        <footer className={styles.statusbar}>
          <span
            className={classNames({
              [styles.saveError]: savedStatus === "Not saved",
            })}
          >
            {savedStatus === "Saving…" ? (
              <Loader2 size={12} className={styles.spin} />
            ) : dirty ? (
              <span className={styles.unsavedDot} />
            ) : (
              <Check size={12} />
            )}
            {savedStatus}
          </span>
          <div>
            <span>
              Ln {position[0]}, Col {position[1]}
            </span>
            <span>UTF-8</span>
            <span className={styles.strudelBadge}>Strudel</span>
          </div>
        </footer>
      </main>

      {controlsVisible && !controllerOpen && (
        <ControlsPanel
          key={`${project?.root}/${panelRoot}`}
          tree={controlTree?.path === panelRoot ? controlTree : null}
          root={panelRoot}
          pinned={Boolean(preferences.pinned)}
          loading={treeLoading}
          disabled={busy}
          layout={panelLayout}
          errors={controlErrors}
          onPin={() =>
            setPreferences((current) => ({
              ...current,
              pinned: current.pinned ? null : panelRoot,
            }))
          }
          onLayout={(layout) => {
            if (panelRoot)
              setPreferences((current) => ({
                ...current,
                roots: { ...current.roots, [panelRoot]: layout },
              }));
          }}
          onChange={editPanelControl}
          onIgnore={(path, name) => editPanelControl(path, name)}
          onDefinition={goToControl}
          onMove={movePanelControl}
          onOpenController={() => setControllerOpen(true)}
        />
      )}

      {context && (
        <div
          className={classNames(styles.menu, styles.contextMenu)}
          style={{ left: context.x, top: context.y }}
        >
          {!context.entry.children && (
            <>
              <button
                type="button"
                onClick={() => void toggleExport(context.entry.id)}
              >
                {context.entry.exported ? (
                  <FileCode2 size={14} />
                ) : (
                  <Package size={14} />
                )}
                {context.entry.exported ? "Remove exports" : "Make exportable"}
              </button>
              <div className={styles.menuDivider} />
            </>
          )}
          {context.entry.children && (
            <>
              <button
                type="button"
                onClick={() =>
                  showModal({
                    kind: "create",
                    parent: context.entry.id,
                    folder: false,
                  })
                }
              >
                <FilePlus2 size={14} />
                New snippet
              </button>
              <button
                type="button"
                onClick={() =>
                  showModal({
                    kind: "create",
                    parent: context.entry.id,
                    folder: true,
                  })
                }
              >
                <FolderPlus size={14} />
                New folder
              </button>
              <div className={styles.menuDivider} />
            </>
          )}
          <button
            type="button"
            onClick={() => showModal({ kind: "rename", entry: context.entry })}
          >
            <Pencil size={14} />
            Rename
          </button>
          <button
            type="button"
            onClick={() => showModal({ kind: "move", entry: context.entry })}
          >
            <ArrowRight size={14} />
            Move to folder…
          </button>
          <button
            type="button"
            className={styles.dangerText}
            onClick={() => showModal({ kind: "delete", entry: context.entry })}
          >
            <Trash2 size={14} />
            Move to Trash
          </button>
        </div>
      )}

      {modal && (
        <Dialog
          title={
            modal.kind === "create"
              ? modal.folder
                ? "New folder"
                : "New snippet"
              : modal.kind === "reload"
                ? "Reload from disk?"
                : modal.kind === "rename"
                  ? "Rename"
                  : modal.kind === "move"
                    ? "Move to folder"
                    : modal.kind === "delete"
                      ? "Move to Trash?"
                      : "A place to play"
          }
          onClose={() => {
            if (!busy) setModal(null);
          }}
        >
          {modal.kind === "help" ? (
            <div className={styles.helpContent}>
              <p>
                Write Strudel code, play it, and follow the sound. Your snippets
                are plain files on your computer.
              </p>
              <div>
                <span>Play / update code</span>
                <kbd>{shortcut} Enter</kbd>
              </div>
              <div>
                <span>Stop playback</span>
                <kbd>{shortcut} .</kbd>
              </div>
              <div>
                <span>Ask Wien</span>
                <kbd>{shortcut} ,</kbd>
              </div>
              <div>
                <span>Save now</span>
                <kbd>{shortcut} S</kbd>
              </div>
              <div>
                <span>Toggle sidebar</span>
                <kbd>{shortcut} B</kbd>
              </div>
              <p className={styles.muted}>
                Drag snippets into folders to organize them. Starter sounds use
                built-in synthesizers and work offline. Playback continues while
                you browse other snippets.
              </p>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => setModal(null)}
              >
                Let’s make something
                <ArrowRight size={14} />
              </button>
            </div>
          ) : (
            <form
              className={styles.modalForm}
              onSubmit={(event) => {
                event.preventDefault();
                void submitModal();
              }}
            >
              {modal.kind === "reload" ? (
                <p>
                  Unsaved edits will be discarded. Copy anything you want to
                  keep before reloading the file from disk.
                </p>
              ) : modal.kind === "delete" ? (
                <p>
                  <strong>{modal.entry.name}</strong>
                  {modal.entry.children ? " and everything inside it" : ""} will
                  move to your computer’s Trash.
                </p>
              ) : modal.kind === "move" ? (
                <>
                  <label htmlFor="destination">Destination</label>
                  <select
                    id="destination"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                  >
                    <option value="">Project root</option>
                    {folders(project?.entries ?? [])
                      .filter((entry) => !isWithin(entry.id, modal.entry.id))
                      .map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.id}
                        </option>
                      ))}
                  </select>
                </>
              ) : (
                <>
                  <label htmlFor="item-name">
                    {modal.kind === "create" && modal.folder
                      ? "Folder name"
                      : "Name"}
                  </label>
                  <input
                    id="item-name"
                    value={value}
                    ref={(input) => {
                      if (
                        input &&
                        window.document.activeElement?.tagName !== "INPUT"
                      ) {
                        input.focus();
                        input.select();
                      }
                    }}
                    onChange={(event) => setValue(event.target.value)}
                    autoComplete="off"
                  />
                  <p className={styles.fieldHint}>
                    {modal.kind === "create"
                      ? `In ${modal.parent || project?.name || "project root"}`
                      : "Use .strudel or .js for snippets."}
                  </p>
                </>
              )}
              {modalError && (
                <p role="alert" className={styles.formError}>
                  {modalError}
                </p>
              )}
              <div className={styles.dialogActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={busy}
                  onClick={() => setModal(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={
                    modal.kind === "delete"
                      ? styles.dangerButton
                      : styles.primaryButton
                  }
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2 size={14} className={styles.spin} />
                  ) : modal.kind === "delete" ? (
                    <Trash2 size={14} />
                  ) : (
                    <ArrowDownToLine size={14} />
                  )}
                  {modal.kind === "create"
                    ? "Create"
                    : modal.kind === "delete"
                      ? "Move to Trash"
                      : modal.kind === "move"
                        ? "Move"
                        : modal.kind === "reload"
                          ? "Discard and reload"
                          : "Rename"}
                </button>
              </div>
            </form>
          )}
        </Dialog>
      )}
    </div>
  );
}
