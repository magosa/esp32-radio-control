"use client";

import type { ActionEditRequest, EditMap, PickRequest } from "./editorTypes";
import type { SceneMap } from "@/scene/types";

// STUB: replaced by Task 7 (single-action dialog for human / room / display rows). Keep the props contract.
export interface ActionDialogProps {
  request: ActionEditRequest;
  map: SceneMap;
  edit: EditMap;
  requestPick(request: PickRequest): void;
  onClose(): void;
}

export function ActionDialog(_props: ActionDialogProps) {
  return null;
}
