import type { SaveState } from "./historyTypes";

export type ShortcutAction = "undo" | "redo";

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: unknown;
}

const TEXT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isTextTarget(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  return !!el && (TEXT_TAGS.has(el.tagName ?? "") || el.isContentEditable === true);
}

export function shortcutAction(event: KeyLike): ShortcutAction | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || isTextTarget(event.target)) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
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
