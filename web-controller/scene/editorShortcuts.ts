import type { SaveState } from "./historyTypes";

export type ShortcutAction = "undo" | "redo" | "togglePlay" | "delete" | "duplicate" | "save";

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: unknown;
}

const TEXT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const INTERACTIVE_TAGS = new Set(["BUTTON", "A", "SUMMARY"]);

export function isTextTarget(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  return !!el && (TEXT_TAGS.has(el.tagName ?? "") || el.isContentEditable === true);
}

function isInteractiveTarget(target: unknown): boolean {
  const el = target as { tagName?: string; getAttribute?: (name: string) => string | null } | null;
  if (!el) return false;
  if (INTERACTIVE_TAGS.has(el.tagName ?? "")) return true;
  const role = typeof el.getAttribute === "function" ? el.getAttribute("role") : null;
  return role === "button" || role === "slider" || role === "tab";
}

export function shortcutAction(event: KeyLike): ShortcutAction | null {
  if (event.altKey || isTextTarget(event.target)) return null;
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (mod) {
    if (key === "z") return event.shiftKey ? "redo" : "undo";
    if (key === "y" && !event.shiftKey) return "redo";
    if (key === "d" && !event.shiftKey) return "duplicate";
    if (key === "s" && !event.shiftKey) return "save";
    return null;
  }
  if (event.shiftKey) return null;
  if (event.key === " " && !isInteractiveTarget(event.target)) return "togglePlay";
  if (event.key === "Delete") return "delete";
  return null;
}

export type SaveTone = "ok" | "busy" | "warn";

export function saveStateLabel(state: SaveState): { text: string; tone: SaveTone } {
  switch (state.kind) {
    case "saved": return { text: `保存済み #${state.revision}`, tone: "ok" };
    case "pending": return { text: `保存中 ${state.count}件`, tone: "busy" };
    case "error": return { text: `保存に失敗 ${state.count}件`, tone: "warn" };
    case "conflict": return { text: "他の画面で更新されました。再読込してください", tone: "warn" };
  }
}
