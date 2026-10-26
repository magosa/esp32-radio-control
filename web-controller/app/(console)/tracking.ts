import type { TrackingState } from "@/fleet/protocol";

export const TRACKING_LABEL: Record<TrackingState, string> = {
  tracking: "追跡中",
  lost: "未検出",
  stale: "測位なし",
  unassigned: "マーカー未割当",
};
