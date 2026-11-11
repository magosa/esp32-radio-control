import { validateProject } from "./model";
import type { SceneProject } from "./types";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const LEGACY_MESSAGE = "移植元の旧形式です。変換機能(S3)で取り込んでください。";
export const TOO_LARGE_MESSAGE = "ファイルが大きすぎます(上限 10 MiB)。";

const SUFFIX = ".fleet-scene.json";

export function fileNameFor(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 80).trim();
  return `${cleaned || "scene"}${SUFFIX}`;
}

export type ParseResult = { ok: true; project: SceneProject } | { ok: false; error: string };

export function parseSceneFile(text: string): ParseResult {
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) return { ok: false, error: TOO_LARGE_MESSAGE };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "JSON として読み込めません。" };
  }
  const schema = typeof value === "object" && value !== null ? (value as { schema?: unknown }).schema : undefined;
  if (typeof schema === "string" && schema.startsWith("robot-scene/")) return { ok: false, error: LEGACY_MESSAGE };
  try {
    return { ok: true, project: validateProject(value) };
  } catch (error) {
    return { ok: false, error: `読み込めません: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function replaceProject(draft: SceneProject, loaded: SceneProject): void {
  const target = draft as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, structuredClone(loaded));
}
