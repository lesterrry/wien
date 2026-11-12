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
  Loader2,
  MoreHorizontal,
  Network,
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
  SquareX,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ControlGroup,
  type PanelPreferences,
  readControlTree,
  readPanelPreferences,
  relocatePanelPreferences,
} from "../../../../shared/control-tree";
import {
  type Control,
  type ControlChange,
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
  type VersionEntry,
} from "../../../../shared/types";
import {
  type Document,
  useSnippetSessions,
} from "../../hooks/useSnippetSessions";
import { ControlsPanel } from "../ControlsPanel/ControlsPanel";
import { Dialog } from "../Dialog/Dialog";
import { Explorer } from "../Explorer/Explorer";
import { FileTabs } from "../FileTabs/FileTabs";
import { GraphView } from "../GraphView/GraphView";
import { StrudelEditor } from "../StrudelEditor/StrudelEditor";
import { VersionsPanel } from "../VersionsPanel/VersionsPanel";
import styles from "./App.module.css";

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
  const navigationBack = useRef(
    new Map<
      string,
      {
        path: string | null;
        fullscreen: boolean;
        root: string | null;
        created: boolean;
      }
    >(),
  );
  const [definitionContext, setDefinitionContext] = useState<{
    target: string;
    path: string | null;
    fullscreen: boolean;
    root: string | null;
    created: boolean;
  } | null>(null);
  const [controllerRoot, setControllerRoot] = useState<string | null>(null);
  const preferencesSave = useRef(Promise.resolve());
  const [definitionTarget, setDefinitionTarget] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const recoveryBlockedRef = useRef(false);
  const {
    sessions,
    sessionsRef,
    document,
    documentRef,
    playback,
    position,
    player,
    players,
    updateDocument: selectDocument,
    patchSession,
    setPlayer,
    removeSessions,
    renameSessions,
    stopAll,
  } = useSnippetSessions();
  const [tabs, setTabs] = useState<string[]>([]);
  const tabsRef = useRef<string[]>([]);
  const saving = useRef<Promise<void> | null>(null);
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
  const [workspaceView, setWorkspaceView] = useState<
    "editor" | "controls" | "graph"
  >("editor");
  const controllerOpen = workspaceView === "controls";
  const graphActive = workspaceView === "graph";
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphFocus, setGraphFocus] = useState<{
    path: string | null;
    revision: number;
  }>({ path: null, revision: 0 });
  const openGraph = (path: string | null = null) => {
    setContext(null);
    setGraphOpen(true);
    setWorkspaceView("graph");
    setGraphFocus((focus) => ({ path, revision: focus.revision + 1 }));
  };
  const closeGraph = useCallback(() => {
    setGraphOpen(false);
    setWorkspaceView((view) => (view === "graph" ? "editor" : view));
  }, []);
  const playingPaths = new Set(
    sessions
      .filter((session) => session.playback.started)
      .map((session) => session.document.path),
  );
  const graphDrafts = Object.fromEntries(
    sessions
      .filter((s) => s.document.code !== s.document.saved)
      .map((s) => [s.document.path, s.document.code]),
  );

  const setControllerOpen = useCallback(
    (open: boolean) => setWorkspaceView(open ? "controls" : "editor"),
    [],
  );
  const playingFile =
    sessions
      .filter((session) => session.playback.started)
      .map((session) => session.document.path)
      .join(", ") || null;
  const pendingControlPaths = useRef(new Set<string>());

  const updateTabs = useCallback((next: string[]) => {
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const updateDocument = useCallback(
    (next: Document | null) => {
      selectDocument(next);
      if (next && !tabsRef.current.includes(next.path))
        updateTabs([...tabsRef.current, next.path]);
    },
    [updateTabs, selectDocument],
  );

  const blockRecovery = useCallback(async () => {
    recoveryBlockedRef.current = true;
    setRecoveryBlocked(true);
    await removeSessions(tabsRef.current);
    updateTabs([]);
    updateDocument(null);
  }, [removeSessions, updateDocument, updateTabs]);

  const flush = useCallback(async () => {
    if (saving.current) return saving.current;
    const work = async () => {
      for (;;) {
        const session = sessionsRef.current.find(
          (s) => s.document.code !== s.document.saved,
        );
        if (!session) break;
        const snapshot = { ...session.document };
        setSavedStatus("Saving…");
        try {
          await api.save({
            path: snapshot.path,
            content: snapshot.code,
            expected: snapshot.saved,
          });
          const current = sessionsRef.current.find((s) => s.id === session.id);
          if (current)
            patchSession(current.id, {
              document: { ...current.document, saved: snapshot.code },
            });
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
  }, [patchSession, sessionsRef]);

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
      const existing = sessionsRef.current.find(
        (s) => s.document.path === path,
      );
      const code = await api.read(path);
      if (existing && code !== existing.document.code)
        players.current.get(existing.id)?.replaceCode(code);
      updateDocument({ path, code, saved: code });
      setSavedStatus("Saved locally");
    },
    [flush, updateDocument, sessionsRef, players],
  );

  const openFile = useCallback(
    async (path: string) => {
      setControllerOpen(false);
      setDefinitionContext(null);
      if (documentRef.current?.path === path) return;
      await run(() => activateFile(path));
    },
    [activateFile, run, documentRef, setControllerOpen],
  );

  const closeTab = useCallback(
    async (path: string) => {
      await run(async () => {
        await controlQueue.current;
        const index = tabsRef.current.indexOf(path);
        if (index < 0) return;
        const remaining = tabsRef.current.filter((item) => item !== path);
        if (documentRef.current?.path === path) {
          await flush();
          const previous = navigationBack.current.get(path);
          const next =
            previous?.path && remaining.includes(previous.path)
              ? previous.path
              : remaining[Math.min(index, remaining.length - 1)];
          if (previous) {
            setControllerRoot(previous.root);
            setControllerOpen(previous.fullscreen);
            setDefinitionContext(null);
          }
          navigationBack.current.delete(path);
          if (next) await activateFile(next);
          else {
            updateDocument(null);
          }
        }
        await removeSessions([path]);
        updateTabs(remaining);
      });
    },
    [
      activateFile,
      flush,
      run,
      updateDocument,
      updateTabs,
      removeSessions,
      documentRef,
      setControllerOpen,
    ],
  );

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

  useEffect(() => {
    if (!project?.root) return;
    let cancelled = false;
    setVersions([]);
    setVersionError(null);
    void api
      .versions()
      .then((entries) => {
        if (!cancelled) setVersions(entries);
      })
      .catch((error) => {
        if (!cancelled) setVersionError(message(error));
      });
    return () => {
      cancelled = true;
    };
  }, [project?.root]);

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
    if (
      !sessions.some(
        (session) => session.document.code !== session.document.saved,
      )
    )
      return;
    const timer = setTimeout(
      () => void flush().catch((error) => setError(message(error))),
      650,
    );
    return () => clearTimeout(timer);
  }, [sessions, flush]);

  useEffect(() => {
    const protectPendingEdits = (event: BeforeUnloadEvent) => {
      if (
        !sessionsRef.current.some(
          (session) => session.document.code !== session.document.saved,
        )
      )
        return;
      event.preventDefault();
      event.returnValue = "";
      void flush().catch((error) => setError(message(error)));
    };
    window.addEventListener("beforeunload", protectPendingEdits);
    return () =>
      window.removeEventListener("beforeunload", protectPendingEdits);
  }, [flush, sessionsRef]);

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
            await preferencesSave.current;
            await flush();
            await stopAll();
            if (selectedVersion && !recoveryBlockedRef.current) {
              try {
                if (
                  (await api.versionChanged()) &&
                  !window.confirm("Discard edits made in this version?")
                ) {
                  api.cancelClose();
                  return;
                }
                await api.restoreVersion();
                setSelectedVersion(null);
              } catch (error) {
                await blockRecovery();
                setError(message(error));
              }
            }
            api.finishClose();
          } catch (error) {
            api.cancelClose();
            throw error;
          }
        });
      }),
    [blockRecovery, flush, run, selectedVersion, stopAll],
  );

  const play = useCallback(() => {
    const target = player.current;
    setError(null);
    void (async () => {
      await controlQueue.current;
      await flush();
      await target?.play();
    })().catch((error) => setError(message(error)));
  }, [flush, player]);
  const stop = useCallback(() => {
    void player.current?.stop();
  }, [player]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "," || event.code === "Comma") {
        event.preventDefault();
        event.stopPropagation();
        if (
          !event.repeat &&
          !busyRef.current &&
          !modal &&
          !controllerOpen &&
          !graphActive
        ) {
          setWorkspaceView("editor");
          player.current?.assist();
        }
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
        if (graphActive) closeGraph();
        else if (controllerOpen) setWorkspaceView("editor");
        else if (documentRef.current) void closeTab(documentRef.current.path);
        else api.close();
      }
      if (event.key === "s") {
        event.preventDefault();
        void flush().catch((error) => setError(message(error)));
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (!graphActive) play();
      }
      if (event.key === "." || event.code === "Period") {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey || graphActive) void stopAll();
        else stop();
      }
      if (event.key === "b") {
        event.preventDefault();
        setSidebar((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    closeTab,
    closeGraph,
    graphActive,
    controllerOpen,
    flush,
    play,
    stop,
    stopAll,
    modal,
    player,
    documentRef,
  ]);

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
    await controlQueue.current;
    setProject(await api.current());
    for (const session of sessionsRef.current) {
      if (session.document.code !== session.document.saved) continue;
      try {
        const code = await api.read(session.document.path);
        if (code !== session.document.code)
          players.current.get(session.id)?.replaceCode(code);
        patchSession(session.id, {
          document: { ...session.document, code, saved: code },
        });
      } catch {
        /* Missing files are diagnosed by the panel and graph. */
      }
    }
    if (
      !sessionsRef.current.some(
        (session) => session.document.code !== session.document.saved,
      )
    )
      setControlErrors({});
    setTreeVersion((version) => version + 1);
  }

  async function syncDocument() {
    for (const session of sessionsRef.current) {
      const code = await api.read(session.document.path);
      if (code !== session.document.code)
        players.current.get(session.id)?.replaceCode(code);
      patchSession(session.id, {
        document: { ...session.document, code, saved: code },
      });
    }
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
    await preferencesSave.current;
    await api.move(from, to);
    const relocate = (file: string) =>
      isWithin(file, from) ? to + file.slice(from.length) : file;
    setPreferences((current) => relocatePanelPreferences(current, from, to));
    setControllerRoot((current) => (current ? relocate(current) : null));
    setDefinitionContext(null);
    navigationBack.current.clear();
    renameSessions(from, to);
    setControlErrors({});
    updateTabs(
      tabsRef.current.map((file) =>
        isWithin(file, from) ? to + file.slice(from.length) : file,
      ),
    );
    setSelection(null);
    await syncDocument();
    await refresh();
    await Promise.all(
      sessionsRef.current
        .filter((session) => session.playback.started)
        .map((session) => players.current.get(session.id)?.update()),
    );
  }

  async function switchProject(create: boolean) {
    await run(async () => {
      await controlQueue.current;
      await preferencesSave.current;
      await flush();
      if (selectedVersion && !recoveryBlockedRef.current) {
        try {
          if (
            (await api.versionChanged()) &&
            !window.confirm("Discard edits made in this version?")
          )
            return;
          await removeSessions(tabsRef.current);
          updateTabs([]);
          updateDocument(null);
          await api.restoreVersion();
          setSelectedVersion(null);
          const restored = await api.current();
          setProject(restored);
          setTreeVersion((version) => version + 1);
          updateTabs([]);
          updateDocument(null);
          const first = restored.entries.find((entry) => !entry.children);
          if (first) {
            const code = await api.read(first.id);
            updateDocument({ path: first.id, code, saved: code });
          }
        } catch (error) {
          await blockRecovery();
          setError(message(error));
        }
      }
      const next = await (create ? api.create() : api.open());
      if (!next) return;
      recoveryBlockedRef.current = false;
      setRecoveryBlocked(false);
      setSelectedVersion(null);
      await removeSessions(tabsRef.current);
      updateTabs([]);
      updateDocument(null);
      setGraphOpen(false);
      setControllerOpen(false);
      setControllerRoot(null);
      setDefinitionContext(null);
      navigationBack.current.clear();
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

  async function changeVersion(oid: string | null) {
    await run(async () => {
      await controlQueue.current;
      await preferencesSave.current;
      await flush();
      if (
        selectedVersion &&
        (await api.versionChanged()) &&
        !window.confirm("Discard edits made in this version?")
      )
        return;
      if (liveUpdateTimer.current !== null) {
        clearTimeout(liveUpdateTimer.current);
        liveUpdateTimer.current = null;
      }
      pendingControlPaths.current.clear();
      await removeSessions(tabsRef.current);
      updateTabs([]);
      updateDocument(null);
      setGraphOpen(false);
      setWorkspaceView("editor");
      try {
        if (oid) await api.selectVersion(oid);
        else await api.restoreVersion();
      } catch (error) {
        if (await api.versionActive()) {
          await blockRecovery();
          setSelectedVersion(oid ?? selectedVersion ?? "recovery");
        }
        throw error;
      }
      recoveryBlockedRef.current = false;
      setRecoveryBlocked(false);
      setSelectedVersion(oid);
      const next = await api.current();
      setProject(next);
      setTreeVersion((version) => version + 1);
      updateTabs([]);
      updateDocument(null);
      setSelection(null);
      const first = next.entries.find((entry) => !entry.children);
      if (first) {
        const code = await api.read(first.id);
        updateDocument({ path: first.id, code, saved: code });
      }
    });
  }

  async function createVersion(versionMessage: string) {
    let saved = false;
    await run(async () => {
      await controlQueue.current;
      await preferencesSave.current;
      await flush();
      try {
        await api.createVersion(versionMessage);
      } catch (error) {
        setVersionError(message(error));
        throw error;
      }
      setVersions(await api.versions());
      saved = true;
    });
    return saved;
  }

  async function restoreLatestVersion(oid: string) {
    await run(async () => {
      if (
        !window.confirm(
          "Restore the latest version? Current changes to .strudel and .js files will be lost, including files created since this version. This cannot be undone.",
        )
      )
        return;
      await controlQueue.current;
      await preferencesSave.current;
      await flush();
      if (liveUpdateTimer.current !== null) {
        clearTimeout(liveUpdateTimer.current);
        liveUpdateTimer.current = null;
      }
      pendingControlPaths.current.clear();
      await removeSessions(tabsRef.current);
      updateTabs([]);
      updateDocument(null);
      setGraphOpen(false);
      setControllerOpen(false);
      setControllerRoot(null);
      setDefinitionContext(null);
      navigationBack.current.clear();
      setSelection(null);
      try {
        await api.restoreLatestVersion(oid);
      } finally {
        const next = await api.current();
        setProject(next);
        setTreeVersion((version) => version + 1);
        const first = next.entries.find((entry) => !entry.children);
        if (first) {
          const code = await api.read(first.id);
          updateDocument({ path: first.id, code, saved: code });
        }
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
          setWorkspaceView("editor");
          const code = await api.read(path);
          updateDocument({ path, code, saved: code });
        }
      } else if (modal.kind === "reload") {
        const current = documentRef.current;
        if (current) {
          const code = await api.read(current.path);
          player.current?.replaceCode(code);
          updateDocument({ path: current.path, code, saved: code });
          setControlErrors({});
          setTreeVersion((version) => version + 1);
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
        await api.trash(modal.entry.id);
        const remaining = tabsRef.current.filter(
          (file) => !isWithin(file, modal.entry.id),
        );
        const deletedActive =
          documentRef.current &&
          isWithin(documentRef.current.path, modal.entry.id);
        await removeSessions(
          tabsRef.current.filter((path) => !remaining.includes(path)),
        );
        updateTabs(remaining);
        if (deletedActive) {
          updateDocument(null);
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
  const panelRoot =
    preferences.pinned ??
    (definitionContext?.fullscreen ? definitionContext.root : null) ??
    document?.path ??
    (controllerOpen ? controllerRoot : null) ??
    null;
  const panelLayout = (panelRoot && preferences.roots[panelRoot]) || {
    hidden: {},
    collapsed: {},
  };

  useEffect(() => {
    if (!project?.root) return;
    let cancelled = false;
    const root = project.root;
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
  }, [project?.root]);

  const projectRoot = project?.root;
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
  }, [projectRoot, preferences, preferencesProject]);

  const treeRevision = JSON.stringify([
    project?.root,
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
              await running.update();
          }
        })
        .catch((error) => setError(message(error)));
    }, 60);
  }

  function previewControl(control: Control, change: ControlChange): Control {
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

  function goToControl(path: string, name: string) {
    void run(async () => {
      await controlQueue.current;
      const context = {
        path: documentRef.current?.path ?? null,
        fullscreen: controllerOpen,
        root: panelRoot,
        created: !tabsRef.current.includes(path),
      };
      navigationBack.current.set(path, context);
      setDefinitionContext({ ...context, target: path });
      setControllerOpen(false);
      if (documentRef.current?.path !== path) await activateFile(path);
      setDefinitionTarget({ path, name });
    });
  }

  function backToControls() {
    if (!definitionContext) return;
    if (definitionContext.created) {
      void closeTab(definitionContext.target);
      return;
    }
    const context = definitionContext;
    void run(async () => {
      if (context.path && context.path !== documentRef.current?.path)
        await activateFile(context.path);
      setControllerRoot(context.root);
      setControllerOpen(context.fullscreen);
      setDefinitionContext(null);
      navigationBack.current.delete(context.target);
    });
  }

  function toggleController() {
    if (!controllerOpen) {
      setControllerRoot(panelRoot);
      setControlsVisible(true);
    }
    setControllerOpen(!controllerOpen);
  }

  // Child editor effects register the player before this effect runs, including
  // when navigation opens a new tab rather than revealing an existing editor.
  useEffect(() => {
    if (definitionTarget && document?.path === definitionTarget.path) {
      const session = sessionsRef.current.find(
        (session) => session.document.path === definitionTarget.path,
      );
      if (session)
        players.current.get(session.id)?.revealControl(definitionTarget.name);
      setDefinitionTarget(null);
    }
  }, [definitionTarget, document?.path, players, sessionsRef]);

  return (
    <div
      className={classNames(styles.app, {
        [styles.sidebarHidden]: !sidebar,
        [styles.controlsHidden]:
          !controlsVisible || controllerOpen || graphActive,
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
              dirty: sessions.some(
                (s) =>
                  s.document.path === path &&
                  s.document.code !== s.document.saved,
              ),
              playing: sessions.some(
                (s) => s.document.path === path && s.playback.started,
              ),
            }))}
            active={document?.path ?? null}
            disabled={busy}
            onSelect={(path) => {
              setWorkspaceView("editor");
              void openFile(path);
            }}
            onClose={(path) => void closeTab(path)}
            graph={{
              open: graphOpen,
              active: graphActive,
              onSelect: () => setWorkspaceView("graph"),
              onClose: closeGraph,
            }}
            controller={{
              open: controllerOpen,
              disabled: busy,
              onSelect: () => {},
              onClose: () => setWorkspaceView("editor"),
            }}
          />
          <button
            type="button"
            className={styles.iconButton}
            title="Toggle controls"
            aria-label="Toggle controls"
            aria-expanded={controlsVisible && !controllerOpen && !graphActive}
            disabled={graphActive}
            onClick={() => {
              if (controllerOpen) {
                setControllerOpen(false);
                setControlsVisible(true);
              } else setControlsVisible(!controlsVisible);
            }}
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
          <VersionsPanel
            versions={versions}
            selected={selectedVersion}
            disabled={busy}
            recoveryBlocked={recoveryBlocked}
            error={versionError}
            onRetry={() => {
              void api
                .versions()
                .then((entries) => {
                  setVersions(entries);
                  setVersionError(null);
                })
                .catch((error) => setVersionError(message(error)));
            }}
            onCreate={createVersion}
            onSelect={(oid) => void changeVersion(oid)}
            onRestoreLatest={(oid) => void restoreLatestVersion(oid)}
          />
          <div className={styles.sidebarBottom}>
            <button
              type="button"
              className={styles.graphLink}
              onClick={() => openGraph()}
              disabled={!project || busy}
              aria-label="Open Graph View"
              aria-current={graphActive ? "page" : undefined}
            >
              <Network size={16} />
              <span>
                Graph View<small>Explore snippet dependencies</small>
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
        className={classNames(styles.workspace, {
          [styles.controllerWorkspace]: controllerOpen || graphActive,
        })}
        id="snippet-panel"
        role="tabpanel"
        aria-labelledby={
          graphActive
            ? "tab-graph"
            : document
              ? `tab-${encodeURIComponent(document.path)}`
              : undefined
        }
        aria-label={graphActive || document ? undefined : "Snippet editor"}
      >
        {!graphActive && (
          <header
            className={styles.editorToolbar}
            role="toolbar"
            aria-label="Snippet toolbar"
          >
            <div className={styles.fileHeading}>
              {controllerOpen && panelRoot ? (
                <>
                  <SlidersHorizontal size={17} />
                  <div>
                    <strong>{panelRoot.split("/").at(-1)}</strong>
                    <span title={panelRoot}>Controls · {panelRoot}</span>
                  </div>
                </>
              ) : document ? (
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
              {definitionContext?.fullscreen && (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={backToControls}
                >
                  Back to controls
                </button>
              )}
              {playback.started && (
                <small
                  className={styles.playingTarget}
                  title={playingFile ?? undefined}
                >
                  Playing {playingFile?.split("/").at(-1)}
                </small>
              )}
              <button
                type="button"
                className={styles.iconButton}
                aria-label="Ask Wien"
                title={`Ask Wien (${shortcut} ,)`}
                disabled={!document || busy || controllerOpen}
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
              {sessions.some(
                (session) =>
                  session.playback.started &&
                  session.document.path !== document?.path,
              ) && (
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Stop all playback"
                  title={`Stop all (${shortcut} ⇧ .)`}
                  onClick={() => void stopAll()}
                >
                  <SquareX size={16} />
                </button>
              )}
              <button
                type="button"
                className={styles.playButton}
                disabled={!document || playback.pending || busy}
                title={
                  document
                    ? `Play / update ${document.path}`
                    : "Open a file to play"
                }
                onClick={play}
              >
                {playback.pending ? (
                  <Loader2 size={14} className={styles.spin} />
                ) : (
                  <Play size={13} fill="currentColor" />
                )}
                <span>
                  {playback.started ? "Update" : "Play"}
                  {controllerOpen &&
                    document &&
                    ` ${document.path.split("/").at(-1)}`}
                </span>
                <kbd>{shortcut} ↵</kbd>
              </button>
              {controllerOpen ? (
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
        )}
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
        <ControlsPanel
          key={`${project?.root}/${panelRoot}`}
          fullscreen={controllerOpen}
          visible={!graphActive && (controlsVisible || controllerOpen)}
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
          onOpenController={toggleController}
          onReloadSource={(path) => {
            if (documentRef.current?.path === path)
              showModal({ kind: "reload" });
            else void run(refresh);
          }}
        />

        {sessions.map((session) => (
          <div
            key={`${project?.root}/${session.id}/${session.version}`}
            className={styles.editorSession}
            data-active={
              session.document.path === document?.path &&
              workspaceView === "editor"
            }
            style={{
              display:
                session.document.path === document?.path &&
                workspaceView === "editor"
                  ? "flex"
                  : "none",
            }}
          >
            <StrudelEditor
              initialCode={session.document.code}
              path={session.document.path}
              active={
                session.document.path === document?.path &&
                workspaceView === "editor"
              }
              disabled={busy}
              onLink={(source) => void linkSnippet(source)}
              onChange={(code) => {
                const current = sessionsRef.current.find(
                  (s) => s.id === session.id,
                );
                if (current) {
                  patchSession(current.id, {
                    document: { ...current.document, code },
                  });
                  setSavedStatus("Unsaved changes");
                }
              }}
              onState={(playback) => patchSession(session.id, { playback })}
              onReady={(next) => setPlayer(session.id, next)}
              onPosition={(line, column) =>
                patchSession(session.id, { position: [line, column] })
              }
            />
          </div>
        ))}
        {!document && !controllerOpen && !graphActive && (
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
        {graphOpen && project && (
          <div className={styles.graphPane} hidden={!graphActive}>
            <GraphView
              key={project.root}
              project={project}
              active={graphActive}
              focus={graphFocus}
              drafts={graphDrafts}
              playingPaths={playingPaths}
              onOpen={(path) => void openFile(path)}
            />
          </div>
        )}
        {!graphActive && playback.error && (
          <div className={styles.evaluationError} role="alert">
            <strong>Couldn’t run this code</strong>
            <span>{playback.error.message}</span>
            {playback.started && (
              <small>The previous version is still playing.</small>
            )}
          </div>
        )}
        {!graphActive && (
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
        )}
      </main>

      {context && (
        <div
          className={classNames(styles.menu, styles.contextMenu)}
          style={{ left: context.x, top: context.y }}
        >
          {!context.entry.children && (
            <>
              <button type="button" onClick={() => openGraph(context.entry.id)}>
                <Network size={14} />
                View in Graph View
              </button>
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
