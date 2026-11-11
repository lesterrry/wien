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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ControlChange,
  changeControl,
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
import {
  type Document,
  useSnippetSessions,
} from "../../hooks/useSnippetSessions";
import { ControllerPanel } from "../ControllerPanel/ControllerPanel";
import { ControlsPanel } from "../ControlsPanel/ControlsPanel";
import { Dialog } from "../Dialog/Dialog";
import { Explorer } from "../Explorer/Explorer";
import { FileTabs } from "../FileTabs/FileTabs";
import { GraphView } from "../GraphView/GraphView";
import { StrudelEditor } from "../StrudelEditor/StrudelEditor";
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
  const [project, setProject] = useState<Project | null>(null);
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
    [selectDocument, updateTabs],
  );

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
      setWorkspaceView("editor");
      if (documentRef.current?.path === path) return;
      await run(() => activateFile(path));
    },
    [activateFile, run, documentRef],
  );

  const closeTab = useCallback(
    async (path: string) => {
      await run(async () => {
        const index = tabsRef.current.indexOf(path);
        if (index < 0) return;
        const remaining = tabsRef.current.filter((item) => item !== path);
        if (documentRef.current?.path === path) {
          await flush();
          const next = remaining[Math.min(index, remaining.length - 1)];
          if (next) await activateFile(next);
          else updateDocument(null);
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
    ],
  );

  const foreignSaves = useRef(new Map<string, Promise<void>>());

  // Serialize per-file read-then-save tasks. Two concurrent calls would
  // otherwise both compute `expected` from the same disk snapshot, and
  // the second would fail with "This file changed on disk". The transform
  // returns `undefined` for no-ops (e.g. same value, self-move), which
  // skip the save entirely.
  const saveForeignEdit = useCallback(
    (
      path: string,
      transform: (code: string) => Edit | undefined,
    ): Promise<void> => {
      const owner = sessionsRef.current.find(
        (s) => s.document.path === documentRef.current?.path,
      );
      const previous = foreignSaves.current.get(path) ?? Promise.resolve();
      const task = previous
        .catch(() => {})
        .then(async () => {
          await flush();
          const code = await api.read(path);
          const edit = transform(code);
          if (!edit) return;
          const next = editSource(code, [edit]);
          await api.save({ path, content: next, expected: code });
          const open = sessionsRef.current.find(
            (s) => s.document.path === path,
          );
          if (open) {
            players.current.get(open.id)?.replaceCode(next);
            patchSession(open.id, {
              document: { path, code: next, saved: next },
            });
            if (open.playback.started && open.id !== owner?.id)
              void players.current
                .get(open.id)
                ?.play()
                .catch((error) => setError(message(error)));
          }
        });

      foreignSaves.current.set(path, task);

      // Only the last queued save in a batch needs to trigger a re-evaluation;
      // intermediate knob values would otherwise spam `play()`.
      const settle = (succeeded: boolean) => {
        if (foreignSaves.current.get(path) !== task) return;
        foreignSaves.current.delete(path);
        if (
          succeeded &&
          owner &&
          sessionsRef.current.find((s) => s.id === owner.id)?.playback.started
        )
          void players.current
            .get(owner.id)
            ?.play()
            .catch((error) => setError(message(error)));
      };
      task.then(
        () => settle(true),
        () => settle(false),
      );

      return task;
    },
    [documentRef, flush, patchSession, players, sessionsRef],
  );

  const saveForeign = useCallback(
    (path: string, name: string, value: ControlChange): Promise<void> =>
      saveForeignEdit(path, (code) => changeControl(code, name, value)),
    [saveForeignEdit],
  );

  const saveForeignMove = useCallback(
    (
      path: string,
      name: string,
      targetName: string,
      placement: "before" | "after",
    ): Promise<void> =>
      saveForeignEdit(path, (code) =>
        moveControl(code, name, targetName, placement),
      ),
    [saveForeignEdit],
  );

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
    if (!sessions.some((s) => s.document.code !== s.document.saved)) return;
    const timer = setTimeout(() => {
      void flush().catch((error) => setError(message(error)));
    }, 650);
    return () => clearTimeout(timer);
  }, [sessions, flush]);

  useEffect(() => {
    const protectPendingEdits = (event: BeforeUnloadEvent) => {
      if (
        !sessionsRef.current.some((s) => s.document.code !== s.document.saved)
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
            await flush();
            await stopAll();
            api.finishClose();
          } catch (error) {
            api.cancelClose();
            throw error;
          }
        });
      }),
    [flush, run, stopAll],
  );

  const play = useCallback(() => {
    void player.current?.play().catch((error) => setError(message(error)));
  }, [player]);
  const stop = useCallback(() => {
    void player.current?.stop();
  }, [player]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "," || event.code === "Comma") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && !busyRef.current && !modal) {
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

  useEffect(() => {
    if (!document && controllerOpen) setWorkspaceView("editor");
  }, [document, controllerOpen]);

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
    await flush();
    await api.move(from, to);
    updateTabs(
      tabsRef.current.map((file) =>
        isWithin(file, from) ? to + file.slice(from.length) : file,
      ),
    );
    renameSessions(from, to);
    setSelection(null);
    await syncDocument();
    await refresh();
  }

  async function switchProject(create: boolean) {
    await run(async () => {
      await flush();
      const next = await (create ? api.create() : api.open());
      if (!next) return;
      await removeSessions(tabsRef.current);
      updateTabs([]);
      updateDocument(null);
      setProject(next);
      setGraphOpen(false);
      setWorkspaceView("editor");
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
          await player.current?.stop();
          updateDocument({ path: current.path, code, saved: code });
          const session = sessionsRef.current.find(
            (s) => s.document.path === current.path,
          );
          if (session)
            patchSession(session.id, {
              version: session.version + 1,
              playback: { started: false, pending: false },
              position: [1, 1],
            });
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
  const controlState = useMemo(
    () => readControls(document?.code ?? ""),
    [document?.code],
  );

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
            aria-expanded={controlsVisible && !graphActive}
            disabled={graphActive}
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
        className={styles.workspace}
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
                onClick={() => {
                  setWorkspaceView("editor");
                  player.current?.assist("bottom");
                }}
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
                (s) => s.playback.started && s.document.path !== document?.path,
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
                onClick={play}
              >
                {playback.pending ? (
                  <Loader2 size={14} className={styles.spin} />
                ) : (
                  <Play size={13} fill="currentColor" />
                )}
                <span>{playback.started ? "Update" : "Play"}</span>
                <kbd>{shortcut} ↵</kbd>
              </button>
              {controllerOpen && document ? (
                <button
                  type="button"
                  className={styles.closeButton}
                  title="Close controls"
                  aria-label="Close controls"
                  onClick={() => setWorkspaceView("editor")}
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
        {sessions.map((session) => (
          <div
            key={`${project?.root}/${session.id}/${session.version}`}
            style={{
              display:
                session.document.path === document?.path &&
                workspaceView === "editor"
                  ? "contents"
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
        {!document && !graphActive && (
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
        {controllerOpen && document && (
          <ControllerPanel
            document={document}
            playback={playback}
            disabled={busy}
            onChange={(name, value) =>
              player.current?.changeControl(name, value)
            }
            onMove={(name, targetName, placement) =>
              player.current?.moveControl(name, targetName, placement)
            }
            onForeignChange={saveForeign}
            onForeignMove={saveForeignMove}
            onError={setError}
          />
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

      {controlsVisible && !controllerOpen && !graphActive && (
        <ControlsPanel
          key={`${project?.root}/${document?.path}`}
          controls={controlState.controls}
          valid={controlState.valid}
          errors={controlState.errors}
          hasDocument={Boolean(document)}
          disabled={busy}
          onChange={(name, value) => player.current?.changeControl(name, value)}
          onIgnore={(name) => player.current?.ignoreControl(name)}
          onMove={(name, targetName, placement) =>
            player.current?.moveControl(name, targetName, placement)
          }
          onOpenController={() => setWorkspaceView("controls")}
        />
      )}

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
                <span>Stop current snippet</span>
                <kbd>{shortcut} .</kbd>
              </div>
              <div>
                <span>Stop all snippets</span>
                <kbd>{shortcut} ⇧ .</kbd>
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
                built-in synthesizers and work offline. Opening another snippet
                stops playback.
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
