"use client";

import type { ActionEditRequest, EditMap, PickRequest } from "./editorTypes";
import type { SceneMap } from "@/scene/types";

// STUB: replaced by Task 7 (batch sequence dialog for robot rows). Keep the props contract.
export interface SequenceDialogProps {
  request: ActionEditRequest;
  map: SceneMap;
  edit: EditMap;
  requestPick(request: PickRequest): void;
  onClose(): void;
}

export function SequenceDialog(_props: SequenceDialogProps) {
  return null;
}
