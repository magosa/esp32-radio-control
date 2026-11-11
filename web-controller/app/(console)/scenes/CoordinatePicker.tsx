"use client";

import type { PickRequest } from "./editorTypes";
import type { SceneMap } from "@/scene/types";

// STUB: replaced by Task 8 (coordinate picker). Keep the props contract.
export interface CoordinatePickerProps {
  request: PickRequest;
  map: SceneMap;
  onClose(): void;
}

export function CoordinatePicker(_props: CoordinatePickerProps) {
  return null;
}
