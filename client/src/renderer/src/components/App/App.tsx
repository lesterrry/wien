import classNames from "classnames";
import { Code2, Plus, X } from "lucide-react";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type CommandId,
  type CommandState,
  commands,
} from "../../../../shared/commands";
import { relocatePanelPreferences } from "../../../../shared/control-tree";
import { hasExports, loadGraph } from "../../../../shared/modules";
import { nextUntitledName } from "../../../../shared/snippet-names";
import {
  type Entry,
  isWithin,
  joinPath,
  type Project,
  parentPath,
  type VersionEntry,
} from "../../../../shared/types";
import { executeEditingCommand } from "../../commands";
import {
  type Document,
  useSnippetSessions,
} from "../../hooks/useSnippetSessions";
import { useAccount } from "../Account/Account";
import { AppMenu } from "../AppMenu/AppMenu";
import { AudioExportDialog } from "../AudioExportDialog/AudioExportDialog";
import { ControlSettingsDialog } from "../ControlSettingsDialog/ControlSettingsDialog";
import { ControlsPanel } from "../ControlsPanel/ControlsPanel";
import { ExamplePickerDialog } from "../ExamplePickerDialog/ExamplePickerDialog";
import { Explorer } from "../Explorer/Explorer";
import { FileContextMenu } from "../FileContextMenu/FileContextMenu";
import { FileOperationDialog } from "../FileOperationDialog/FileOperationDialog";
import { FileTabs } from "../FileTabs/FileTabs";
import { GettingStartedDialog } from "../GettingStartedDialog/GettingStartedDialog";
import { GraphView } from "../GraphView/GraphView";
import { Onboarding } from "../Onboarding/Onboarding";
import { hasSeenOnboarding } from "../Onboarding/onboarding-state";
import { PlaybackControls } from "../PlaybackControls/PlaybackControls";
import { ProjectMenu } from "../ProjectMenu/ProjectMenu";
import { SnippetToolbar } from "../SnippetToolbar/SnippetToolbar";
import { StrudelEditor } from "../StrudelEditor/StrudelEditor";
import { VersionsPanel } from "../VersionsPanel/VersionsPanel";
import { WorkspaceSidebar } from "../WorkspaceSidebar/WorkspaceSidebar";
import { WorkspaceStatus } from "../WorkspaceStatus/WorkspaceStatus";
import { WorkspaceTitlebar } from "../WorkspaceTitlebar/WorkspaceTitlebar";
import styles from "./App.module.css";
import { useControlPanel } from "./useControlPanel";
import { useWorkspaceCommands } from "./useWorkspaceCommands";
import type { Modal } from "./workspace-types";
import { findEntry, markExports, message } from "./workspace-utils";

const api = window.workspace;
export function App() {
  const {
    user,
    resolved: accountResolved,
    dialogOpen: accountDialogOpen,
  } = useAccount();
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
  const [examples, setExamples] = useState<string[]>([]);
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

  const {
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
  } = useControlPanel({
    projectRoot: project?.root,
    activePath:
      (definitionContext?.fullscreen ? definitionContext.root : null) ??
      document?.path ??
      (controllerOpen ? controllerRoot : null) ??
      null,
    sessions,
    sessionsRef,
    players,
    flush,
    run,
    busyRef,
    setBusy,
    setError,
  });
  const onboardingRequested = useRef(false);
  useEffect(() => {
    if (
      !accountResolved ||
      user ||
      !project ||
      busy ||
      modal ||
      controlSettings ||
      accountDialogOpen ||
      onboardingRequested.current
    )
      return;
    onboardingRequested.current = true;
    if (!hasSeenOnboarding()) setModal({ kind: "onboarding" });
  }, [
    accountResolved,
    user,
    project,
    busy,
    modal,
    controlSettings,
    accountDialogOpen,
  ]);

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
    [flush, updateDocument, sessionsRef, players, controlQueue.current],
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
      controlQueue.current,
    ],
  );

  useEffect(() => {
    if (!project?.root || api.platform === "web") return;
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
      .examples()
      .then(setExamples)
      .catch((error) => setError(message(error)));
  }, []);

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
    [
      blockRecovery,
      flush,
      run,
      selectedVersion,
      stopAll,
      preferencesSave.current,
      controlQueue.current,
    ],
  );

  const play = useCallback(() => {
    const target = player.current;
    setError(null);
    void (async () => {
      await controlQueue.current;
      await flush();
      await target?.play();
    })().catch((error) => setError(message(error)));
  }, [flush, player, controlQueue.current]);
  const stop = useCallback(() => {
    void player.current?.stop();
  }, [player]);

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

  function openSnippetActions(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!document) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setContext({
      entry: {
        id: document.path,
        name: document.path.split("/").at(-1) ?? document.path,
        exported: hasExports(document.code),
      },
      x: rect.right - 220,
      y: rect.bottom + 8,
    });
  }

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

  const refresh = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      await controlQueue.current;
      if (!isCurrent()) return;
      const next = await api.current();
      if (!isCurrent()) return;
      setProject(next);
      setSelection((current) =>
        current ? (findEntry(next.entries, current.id) ?? null) : null,
      );
      for (const session of sessionsRef.current) {
        if (!isCurrent()) return;
        if (session.document.code !== session.document.saved) continue;
        try {
          const code = await api.read(session.document.path);
          // A filesystem read may finish after typing, a rename or a switch.
          // Only replace the exact clean document that was read.
          if (!isCurrent()) return;
          if (
            sessionsRef.current.find((current) => current.id === session.id)
              ?.document !== session.document ||
            code === session.document.code
          )
            continue;
          players.current.get(session.id)?.replaceCode(code);
          patchSession(session.id, {
            document: { ...session.document, code, saved: code },
          });
        } catch {
          /* Missing files are diagnosed by the panel and graph. */
        }
      }
      if (!isCurrent()) return;
      if (
        !sessionsRef.current.some(
          (session) => session.document.code !== session.document.saved,
        )
      )
        setControlErrors({});
      setTreeVersion((version) => version + 1);
    },
    [
      patchSession,
      players,
      sessionsRef,
      setTreeVersion,
      setControlErrors,
      controlQueue.current,
    ],
  );

  useEffect(() => {
    if (!project?.root) return;
    const root = project.root;
    let disposed = false;
    let running = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      pending = true;
      clearTimeout(timer);
      timer = setTimeout(update, 100);
    };
    const update = async () => {
      if (disposed || running) return;
      if (busyRef.current || controlWrites.current > 0) {
        schedule();
        return;
      }
      pending = false;
      running = true;
      try {
        await refresh(() => {
          if (disposed) return false;
          if (busyRef.current || controlWrites.current > 0) {
            pending = true;
            return false;
          }
          return true;
        });
      } catch (error) {
        if (!disposed) setError(message(error));
      } finally {
        running = false;
        if (pending && !disposed) schedule();
      }
    };
    const unsubscribe = api.onProjectChanged((changedRoot) => {
      if (changedRoot === root) schedule();
    });
    // Close the initial read/subscription gap and reconcile after app sleep.
    schedule();
    window.addEventListener("focus", schedule);
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", schedule);
    };
  }, [project?.root, refresh, controlWrites.current]);

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

  async function switchProject(create: boolean, example?: string) {
    setProjectMenu(false);
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
      const next = await (create ? api.create(example) : api.open());
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
      cancelLiveUpdate();
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
  async function createUntitledSnippet() {
    if (!project || selectedVersion || recoveryBlocked) return;
    await run(async () => {
      await controlQueue.current;
      await flush();
      const current = await api.current();
      const siblings = destination
        ? (findEntry(current.entries, destination)?.children ?? [])
        : current.entries;
      const path = await api.add(
        destination,
        nextUntitledName(siblings),
        false,
      );
      await refresh();
      const code = await api.read(path);
      setWorkspaceView("editor");
      setDefinitionContext(null);
      updateDocument({ path, code, saved: code });
      setSelection({ id: path, name: path.split("/").at(-1) ?? path });
      setSavedStatus("Saved locally");
    });
  }

  function renameActiveSnippet() {
    const current = documentRef.current;
    if (
      !current ||
      busyRef.current ||
      selectedVersion ||
      recoveryBlocked ||
      graphActive ||
      controllerOpen
    )
      return;
    showModal({
      kind: "rename",
      entry: {
        id: current.path,
        name: current.path.split("/").at(-1) ?? current.path,
      },
    });
  }

  const dirty = document?.code !== document?.saved;
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

  const handleCommand = (command: CommandId) => {
    const dialogOpen = Boolean(window.document.querySelector("dialog[open]"));
    if (command === "stopAll") {
      void stopAll();
      return;
    }
    if (busyRef.current || dialogOpen) return;
    if (command.startsWith("tab")) {
      const tabs = window.document.querySelectorAll<HTMLButtonElement>(
        '[role="tablist"][aria-label="Open snippets"] [role="tab"]',
      );
      const number = Number(command.slice(3));
      tabs[number === 9 ? tabs.length - 1 : number - 1]?.click();
      return;
    }
    switch (command) {
      case "play":
        if (!graphActive) play();
        break;
      case "stop":
        stop();
        break;
      case "assist":
        if (!controllerOpen && !graphActive) player.current?.assist();
        break;
      case "save":
        void flush().catch((error) => setError(message(error)));
        break;
      case "closeTab":
        if (graphActive) closeGraph();
        else if (controllerOpen) setWorkspaceView("editor");
        else if (documentRef.current) void closeTab(documentRef.current.path);
        break;
      case "sidebar":
        setSidebar((value) => !value);
        break;
      case "controls":
        if (controllerOpen) {
          setControllerOpen(false);
          setControlsVisible(true);
        } else if (!graphActive) setControlsVisible((value) => !value);
        break;
      case "graph":
        openGraph();
        break;
      case "newProject":
        void switchProject(true);
        break;
      case "openProject":
        void switchProject(false);
        break;
      case "newFile":
        void createUntitledSnippet();
        break;
      case "renameFile":
        renameActiveSnippet();
        break;
      case "newFolder":
        if (selectedVersion || recoveryBlocked) break;
        setValue("");
        setModalError(null);
        setModal({
          kind: "create",
          parent: destination,
          folder: true,
        });
        break;
      case "exportProject":
        void run(async () => {
          await flush();
          await api.exportProject?.();
        });
        break;
      case "help":
        setModal({ kind: "help" });
        break;
      case "controlUp":
      case "controlDown": {
        const control = window.document.activeElement?.closest<HTMLElement>(
          "[data-control-move]",
        );
        control?.dispatchEvent(
          new CustomEvent("wien:move-control", {
            detail: command === "controlUp" ? "up" : "down",
          }),
        );
        break;
      }
      default:
        void Promise.resolve(executeEditingCommand(command)).catch((error) =>
          setError(message(error)),
        );
    }
  };
  const { menuState, dispatchCommand } = useWorkspaceCommands(
    handleCommand,
    (dialogClosed) => {
      const available = dialogClosed && !busyRef.current;
      const state: CommandState = Object.fromEntries(
        commands.map((command) => [command.id, available]),
      );
      state.play = available && !graphActive && Boolean(player.current);
      state.assist = state.play && !controllerOpen;
      state.stop = available && Boolean(player.current);
      state.stopAll = true;
      state.save =
        available &&
        Boolean(documentRef.current) &&
        !selectedVersion &&
        !recoveryBlocked;
      state.closeTab =
        available &&
        Boolean(documentRef.current || graphActive || controllerOpen);
      state.newFile = state.newFolder =
        available && Boolean(project) && !selectedVersion && !recoveryBlocked;
      state.renameFile =
        available &&
        Boolean(documentRef.current) &&
        !selectedVersion &&
        !recoveryBlocked &&
        !graphActive &&
        !controllerOpen;
      state.controls = available && !graphActive;
      const control = window.document.activeElement?.closest<HTMLElement>(
        "[data-control-move]",
      );
      state.controlUp = available && control?.dataset.moveUp === "true";
      state.controlDown = available && control?.dataset.moveDown === "true";
      return state;
    },
  );
  const playbackProps = {
    path: document?.path ?? null,
    busy,
    playback,
    onPlay: play,
    onStop: stop,
    onActions: openSnippetActions,
  };
  const fileTabs = (
    <FileTabs
      tabs={tabs.map((path) => ({
        path,
        exported:
          path === document?.path
            ? hasExports(document.code)
            : Boolean(findEntry(project?.entries ?? [], path)?.exported),
        dirty: sessions.some(
          (s) =>
            s.document.path === path && s.document.code !== s.document.saved,
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
  );
  const projectMenuContent = (
    <ProjectMenu
      projectName={project?.name}
      open={projectMenu}
      onOpenChange={setProjectMenu}
      busy={busy}
      hasExamples={examples.length > 0}
      onSwitchProject={(create) => void switchProject(create)}
      onExamples={() => showModal({ kind: "examples" })}
      onExport={() =>
        void run(async () => {
          await flush();
          await api.exportProject?.();
        })
      }
      onReveal={() =>
        void api.reveal().catch((error) => setError(message(error)))
      }
    />
  );
  const explorerContent = (
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
            await move(path, joinPath(parent, path.split("/").at(-1) ?? path));
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
  );
  const versionsContent = api.platform !== "web" && (
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
    />
  );
  return (
    <div
      className={classNames(styles.app, {
        [styles.sidebarHidden]: !sidebar,
        [styles.controlsHidden]:
          !controlsVisible || controllerOpen || graphActive,
      })}
    >
      {api.platform === "web" && (
        <AppMenu hidden state={menuState} onCommand={dispatchCommand} />
      )}
      <WorkspaceTitlebar
        playing={playingPaths.size > 0}
        sidebar={sidebar}
        onSidebar={() => setSidebar(!sidebar)}
        controlsVisible={controlsVisible}
        controllerOpen={controllerOpen}
        graphActive={graphActive}
        onControls={() => {
          if (controllerOpen) {
            setControllerOpen(false);
            setControlsVisible(true);
          } else setControlsVisible(!controlsVisible);
        }}
        tabs={fileTabs}
      />

      {sidebar && (
        <WorkspaceSidebar
          busy={busy}
          projectReady={Boolean(project)}
          search={search}
          onSearch={setSearch}
          onCreate={(folder) =>
            showModal({ kind: "create", parent: destination, folder })
          }
          onGraph={() => openGraph()}
          onHelp={() => showModal({ kind: "help" })}
          projectMenu={projectMenuContent}
          versions={versionsContent}
          explorer={explorerContent}
        />
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
        {!graphActive && !controllerOpen && (
          <SnippetToolbar
            document={document}
            projectName={project?.name}
            busy={busy}
            readOnly={Boolean(selectedVersion) || recoveryBlocked}
            onRename={renameActiveSnippet}
            onBack={definitionContext?.fullscreen ? backToControls : undefined}
            onAssist={() => player.current?.assist("bottom")}
            playbackControls={
              <PlaybackControls
                {...playbackProps}
                onStopAll={
                  sessions.some(
                    (session) =>
                      session.playback.started &&
                      session.document.path !== document?.path,
                  )
                    ? () => void stopAll()
                    : undefined
                }
              />
            }
          />
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
          headerActions={
            controllerOpen ? (
              <div className={styles.transport}>
                <PlaybackControls {...playbackProps} />
              </div>
            ) : undefined
          }
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
          onConfigure={openControlSettings}
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
              sourceRevision={treeVersion}
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
          <WorkspaceStatus
            savedStatus={savedStatus}
            dirty={dirty}
            position={position}
          />
        )}
      </main>

      {context && (
        <FileContextMenu
          context={context}
          busy={busy}
          recoveryBlocked={recoveryBlocked}
          onModal={showModal}
          onGraph={openGraph}
          onToggleExport={(path) => void toggleExport(path)}
        />
      )}

      {controlSettings && (
        <ControlSettingsDialog
          control={controlSettings.control}
          path={controlSettings.path}
          initial={controlSettings.initial}
          onSave={saveControlSettings}
          onClose={() => setControlSettings(null)}
        />
      )}
      {modal?.kind === "examples" && (
        <ExamplePickerDialog
          examples={examples}
          onClose={() => setModal(null)}
          onSelect={(example) => {
            setModal(null);
            void switchProject(true, example);
          }}
        />
      )}
      {modal?.kind === "audio-export" && (
        <AudioExportDialog
          path={modal.path}
          snapshot={() => {
            const drafts = new Map(
              sessionsRef.current.map((session) => [
                session.document.path,
                session.document.code,
              ]),
            );
            return loadGraph(
              modal.path,
              async (path) => drafts.get(path) ?? (await api.read(path)),
            );
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === "onboarding" && (
        <Onboarding
          onClose={() => setModal(null)}
          onExamples={() => showModal({ kind: "examples" })}
        />
      )}
      {modal?.kind === "help" && (
        <GettingStartedDialog
          onClose={() => {
            if (!busy) setModal(null);
          }}
          onTour={() => showModal({ kind: "onboarding" })}
        />
      )}
      {modal &&
        (modal.kind === "create" ||
          modal.kind === "rename" ||
          modal.kind === "move" ||
          modal.kind === "delete" ||
          modal.kind === "reload") && (
          <FileOperationDialog
            modal={modal}
            entries={project?.entries ?? []}
            projectName={project?.name}
            value={value}
            onValue={setValue}
            busy={busy}
            modalError={modalError}
            onSubmit={() => void submitModal()}
            onClose={() => setModal(null)}
          />
        )}
    </div>
  );
}
