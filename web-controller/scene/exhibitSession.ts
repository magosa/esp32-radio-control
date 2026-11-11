// The exhibit screen shows one map at one scene time. The Hub keeps this record and relays it, so a screen on another PC follows the operator.

export const MAX_EXHIBIT_SECONDS = 86_400;
const MAX_MAP_ID = 100;

export interface ExhibitSession {
  mapId: string | null;
  running: boolean;
  // Scene time (seconds) at `startedAt`; while paused it is the current time.
  position: number;
  // Hub clock (ms since epoch) when `position` was valid.
  startedAt: number;
}

export type ExhibitCommand =
  | { type: "open"; mapId: string }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; time: number }
  | { type: "close" };

export const initialExhibit = (now = 0): ExhibitSession => ({ mapId: null, running: false, position: 0, startedAt: now });

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function parseExhibitCommand(value: unknown): ExhibitCommand | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  switch (item.type) {
    case "open": {
      const id = item.mapId;
      return typeof id === "string" && id.length > 0 && id.length <= MAX_MAP_ID ? { type: "open", mapId: id } : null;
    }
    case "seek":
      return finite(item.time) && item.time >= 0 && item.time <= MAX_EXHIBIT_SECONDS ? { type: "seek", time: item.time } : null;
    case "play": case "pause": case "close":
      return { type: item.type };
    default:
      return null;
  }
}

// The scene time at `now`. `duration` stops the clock at the end of the scene; pass Infinity when it is unknown.
export function exhibitTime(session: ExhibitSession, now: number, duration = Infinity): number {
  const elapsed = session.running ? Math.max(0, (now - session.startedAt) / 1000) : 0;
  return Math.min(Math.max(0, duration), Math.max(0, session.position + elapsed));
}

// Returns the next session, or the reason the command cannot apply.
export function applyExhibit(session: ExhibitSession, command: ExhibitCommand, now: number): ExhibitSession | string {
  const at = exhibitTime(session, now);
  const next = (change: Partial<ExhibitSession>): ExhibitSession => ({ ...session, ...change });
  switch (command.type) {
    case "open":
      return next({ mapId: command.mapId, running: false, position: 0, startedAt: now });
    case "close":
      return next({ mapId: null, running: false, position: 0, startedAt: now });
    case "play":
      if (session.mapId === null) return "展示するマップが選ばれていません。";
      return session.running ? session : next({ running: true, position: at, startedAt: now });
    case "pause":
      return session.running ? next({ running: false, position: at, startedAt: now }) : session;
    case "seek":
      if (session.mapId === null) return "展示するマップが選ばれていません。";
      return next({ position: command.time, startedAt: now });
  }
}
