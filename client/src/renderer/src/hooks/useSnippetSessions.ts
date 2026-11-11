import type { ReplState } from "@strudel/codemirror";
import { useCallback, useRef, useState } from "react";
import { isWithin } from "../../../shared/types";
import type { Player } from "../components/StrudelEditor/StrudelEditor";

export interface Document {
  path: string;
  code: string;
  saved: string;
}

interface Session {
  id: string;
  document: Document;
  playback: ReplState;
  position: [number, number];
  version: number;
}

const stopped: ReplState = { started: false, pending: false };

// A tab owns its editor and scheduler until it closes. The active document is
// only a view into that collection; selecting another tab never disposes it.
export function useSnippetSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const sessionsRef = useRef<Session[]>([]);
  const active = useRef<string | null>(null);
  const documentRef = useRef<Document | null>(null);
  const players = useRef(new Map<string, Player>());
  const player = useRef<Player | null>(null);

  const publish = useCallback((next: Session[]) => {
    sessionsRef.current = next;
    const selected = next.find((session) => session.id === active.current);
    documentRef.current = selected?.document ?? null;
    player.current = selected
      ? (players.current.get(selected.id) ?? null)
      : null;
    setSessions(next);
  }, []);

  const patchSession = useCallback(
    (id: string, patch: Partial<Session>) => {
      publish(
        sessionsRef.current.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      );
    },
    [publish],
  );

  const updateDocument = useCallback(
    (document: Document | null) => {
      if (!document) {
        active.current = null;
        publish([...sessionsRef.current]);
        return;
      }
      const existing = sessionsRef.current.find(
        (s) => s.document.path === document.path,
      );
      if (existing) {
        active.current = existing.id;
        patchSession(existing.id, { document });
      } else {
        const id = crypto.randomUUID();
        active.current = id;
        publish([
          ...sessionsRef.current,
          { id, document, playback: stopped, position: [1, 1], version: 0 },
        ]);
      }
    },
    [patchSession, publish],
  );

  const setPlayer = useCallback((id: string, next: Player | null) => {
    if (next) players.current.set(id, next);
    else players.current.delete(id);
    if (active.current === id) player.current = next;
  }, []);

  const removeSessions = useCallback(
    async (paths: string[]) => {
      const removed = sessionsRef.current.filter((s) =>
        paths.includes(s.document.path),
      );
      await Promise.all(removed.map((s) => players.current.get(s.id)?.stop()));
      for (const s of removed) players.current.delete(s.id);
      publish(
        sessionsRef.current.filter((s) => !paths.includes(s.document.path)),
      );
    },
    [publish],
  );

  const stopAll = useCallback(async () => {
    await Promise.all(
      [...players.current.values()].map((player) => player.stop()),
    );
  }, []);

  const renameSessions = useCallback(
    (from: string, to: string) => {
      publish(
        sessionsRef.current.map((s) =>
          isWithin(s.document.path, from)
            ? {
                ...s,
                document: {
                  ...s.document,
                  path: to + s.document.path.slice(from.length),
                },
              }
            : s,
        ),
      );
    },
    [publish],
  );

  const selected = sessions.find((s) => s.id === active.current);
  return {
    sessions,
    sessionsRef,
    document: selected?.document ?? null,
    documentRef,
    playback: selected?.playback ?? stopped,
    position: selected?.position ?? [1, 1],
    player,
    players,
    updateDocument,
    patchSession,
    setPlayer,
    removeSessions,
    renameSessions,
    stopAll,
  };
}
