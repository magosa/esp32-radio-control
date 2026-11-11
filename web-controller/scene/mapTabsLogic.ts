export const MAX_MAPS = 8;
const MAX_NAME_CHARS = 60;

export function nextMapName(names: string[]): string {
  const used = new Set(names);
  let n = 1;
  while (used.has(`マップ ${n}`)) n++;
  return `マップ ${n}`;
}

export function validateMapName(raw: string, _existing?: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim();
  if (name === "") return { ok: false, error: "マップ名を入力してください。" };
  if (Array.from(name).length > MAX_NAME_CHARS) return { ok: false, error: `マップ名は${MAX_NAME_CHARS}文字以内にしてください。` };
  return { ok: true, name };
}

export const canAddMap = (count: number): boolean => count < MAX_MAPS;
export const canDeleteMap = (count: number): boolean => count > 1;

export function neighbourTab(ids: string[], activeId: string, key: "ArrowLeft" | "ArrowRight" | "Home" | "End"): string {
  if (ids.length === 0) return activeId;
  if (key === "Home") return ids[0];
  if (key === "End") return ids[ids.length - 1];
  const index = ids.indexOf(activeId);
  if (index < 0) return ids[0];
  const step = key === "ArrowRight" ? 1 : -1;
  return ids[(index + step + ids.length) % ids.length];
}

export function afterDelete(ids: string[], deletedId: string, activeId: string): string | null {
  if (deletedId !== activeId) return null;
  return ids.find((id) => id !== deletedId) ?? null;
}
