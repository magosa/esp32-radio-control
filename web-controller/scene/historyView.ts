export function sortNewestFirst<T extends { revision: number }>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => b.revision - a.revision);
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${p(date.getMonth() + 1)}/${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

export function restoredLabel(restoredFrom: number | null | undefined): string {
  return restoredFrom === null || restoredFrom === undefined ? "" : `#${restoredFrom} から復元`;
}
