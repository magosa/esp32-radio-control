"use client";

import type { Commit } from "@/scene/sceneSession";
import type { SceneProject } from "@/scene/types";

export interface FileActionsProps {
  project: SceneProject;
  commit: Commit;
}

// Task 8 で JSON の保存・読込を実装する。props は変更しないこと。
export function FileActions(_props: FileActionsProps) {
  return null;
}
