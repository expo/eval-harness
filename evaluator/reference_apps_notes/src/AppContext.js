import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { loadNotes, saveNotes } from './storage';
import { generateId } from './utils';

const PASSWORD = 'my-notes-are-mine';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [unlocked, setUnlocked] = useState(false);
  const [notes, setNotes] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const stored = await loadNotes();
      setNotes(stored);
      setLoaded(true);
    })();
  }, []);

  const persist = useCallback(async (next) => {
    setNotes(next);
    await saveNotes(next);
  }, []);

  const attemptUnlock = useCallback((value) => {
    if (!value || value.length === 0) {
      return { ok: false, error: 'Password is required' };
    }
    if (value !== PASSWORD) {
      return { ok: false, error: 'Incorrect password' };
    }
    setUnlocked(true);
    return { ok: true };
  }, []);

  const createNote = useCallback(async () => {
    const now = Date.now();
    const note = { id: generateId(), body: '', updatedAt: now, createdAt: now };
    const next = [note, ...notes];
    await persist(next);
    return note;
  }, [notes, persist]);

  const updateNote = useCallback(async (id, body) => {
    let changed = false;
    const next = notes.map((n) => {
      if (n.id !== id) return n;
      if (n.body === body) return n;
      changed = true;
      return { ...n, body, updatedAt: Date.now() };
    });
    if (changed) {
      await persist(next);
    }
  }, [notes, persist]);

  const deleteNote = useCallback(async (id) => {
    const next = notes.filter((n) => n.id !== id);
    await persist(next);
  }, [notes, persist]);

  const getNote = useCallback((id) => notes.find((n) => n.id === id) || null, [notes]);

  const sortedNotes = useMemo(
    () => [...notes].sort((a, b) => b.updatedAt - a.updatedAt),
    [notes]
  );

  const value = {
    unlocked,
    attemptUnlock,
    notes: sortedNotes,
    loaded,
    createNote,
    updateNote,
    deleteNote,
    getNote,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
