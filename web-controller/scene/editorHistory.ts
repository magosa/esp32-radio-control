export const UNDO_LIMIT = 40;

export interface EditorHistory<T> {
  present: T;
  past: T[];
  future: T[];
}

export function initHistory<T>(present: T): EditorHistory<T> {
  return { present, past: [], future: [] };
}

export function pushEdit<T>(h: EditorHistory<T>, next: T, limit: number = UNDO_LIMIT): EditorHistory<T> {
  const past = [...h.past, h.present];
  if (past.length > limit) past.splice(0, past.length - limit);
  return { present: next, past, future: [] };
}

export function undo<T>(h: EditorHistory<T>): EditorHistory<T> {
  if (h.past.length === 0) return h;
  return {
    present: h.past[h.past.length - 1],
    past: h.past.slice(0, -1),
    future: [h.present, ...h.future],
  };
}

export function redo<T>(h: EditorHistory<T>): EditorHistory<T> {
  if (h.future.length === 0) return h;
  return {
    present: h.future[0],
    past: [...h.past, h.present],
    future: h.future.slice(1),
  };
}

export function canUndo<T>(h: EditorHistory<T>): boolean {
  return h.past.length > 0;
}

export function canRedo<T>(h: EditorHistory<T>): boolean {
  return h.future.length > 0;
}
