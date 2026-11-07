import { useCallback, useReducer } from 'react';
import type { WorkspaceState } from './types';

type Updater = (prev: WorkspaceState) => WorkspaceState;

type Action =
  | { type: 'commit'; update: Updater }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset' };

interface History {
  past: WorkspaceState[];
  present: WorkspaceState;
  future: WorkspaceState[];
}

const EMPTY: WorkspaceState = { docs: [], pages: [], annotations: [] };

function reducer(h: History, a: Action): History {
  switch (a.type) {
    case 'commit': {
      const next = a.update(h.present);
      if (next === h.present) return h;
      return { past: [...h.past.slice(-49), h.present], present: next, future: [] };
    }
    case 'undo': {
      if (!h.past.length) return h;
      return {
        past: h.past.slice(0, -1),
        present: h.past[h.past.length - 1],
        future: [h.present, ...h.future],
      };
    }
    case 'redo': {
      if (!h.future.length) return h;
      return {
        past: [...h.past, h.present],
        present: h.future[0],
        future: h.future.slice(1),
      };
    }
    case 'reset':
      return { past: [...h.past.slice(-49), h.present], present: EMPTY, future: [] };
  }
}

export function useHistory() {
  const [h, dispatch] = useReducer(reducer, { past: [], present: EMPTY, future: [] });
  const commit = useCallback((update: Updater) => dispatch({ type: 'commit', update }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  return {
    state: h.present,
    commit, undo, redo, reset,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
  };
}
