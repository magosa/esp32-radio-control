"use client";

import type { SceneHistoryApi } from "@/hooks/useSceneProject";
import type { SaveState } from "@/scene/historyTypes";

export interface HistoryDialogProps {
  open: boolean;
  onClose(): void;
  history: SceneHistoryApi;
  saveState: SaveState;
}

// Task 8 で一覧・適用・再試行を実装する。props は変更しないこと。
export function HistoryDialog(_props: HistoryDialogProps) {
  return null;
}
