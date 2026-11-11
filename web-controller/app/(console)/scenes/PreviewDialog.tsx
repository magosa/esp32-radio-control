"use client";

import type { PlaybackControls } from "./editorTypes";
import type { SceneMap } from "@/scene/types";

// STUB: replaced by Task 10 (fullscreen preview). Keep the props contract.
export interface PreviewDialogProps {
  open: boolean;
  map: SceneMap;
  playback: PlaybackControls;
  onClose(): void;
}

export function PreviewDialog(_props: PreviewDialogProps) {
  return null;
}
