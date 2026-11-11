import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { projectForSave, validateProject } from "../scene/model";
import type { SceneProject } from "../scene/types";
import type { AppendRequest, SceneHistoryMeta, SceneHistoryRecord } from "../scene/historyTypes";

export type AppendResult =
  | { status: "created" | "duplicate"; record: SceneHistoryRecord }
  | { status: "conflict"; latestRevision: number };

// 呼び出し側の入力が不正なとき（HTTP では 400 に対応）。
export class SceneHistoryError extends Error {
  readonly status = 400;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const LABEL_MAX = 120;
const FILE_PATTERN = /^\d{10}\.json$/;
const LOCK_NAME = "writer.lock";

const digest = (project: unknown) => createHash("sha256").update(JSON.stringify(project)).digest("hex");
const fileName = (revision: number) => `${String(revision).padStart(10, "0")}.json`;
const toMeta = ({ revision, id, timestamp, label, restoredFrom, hash }: SceneHistoryRecord): SceneHistoryMeta =>
  ({ revision, id, timestamp, label, restoredFrom, hash });

function bad(message: string): never {
  throw new SceneHistoryError(message);
}

// 外部入力（JSON 本文）を AppendRequest として検証する。project の中身は append 側で検証する。
export function parseAppendRequest(value: unknown): AppendRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad("request body must be an object");
  const body = value as Record<string, unknown>;
  const { expectedRevision, id, label, project, restoredFrom } = body;
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    bad("expectedRevision must be a non-negative integer");
  if (typeof id !== "string" || !ID_PATTERN.test(id)) bad("id must be 1-80 characters of letters, digits, _ or -");
  if (typeof label !== "string" || label.trim().length === 0 || label.length > LABEL_MAX)
    bad(`label must be a string of 1-${LABEL_MAX} characters`);
  if (typeof project !== "object" || project === null || Array.isArray(project)) bad("project must be an object");
  if (restoredFrom !== undefined && restoredFrom !== null &&
      (typeof restoredFrom !== "number" || !Number.isSafeInteger(restoredFrom) || restoredFrom < 1))
    bad("restoredFrom must be a positive integer or null");
  return { expectedRevision, id, label, project, ...(restoredFrom === undefined ? {} : { restoredFrom }) };
}

function readRecords(dir: string): SceneHistoryRecord[] {
  const entries = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  const records: SceneHistoryRecord[] = [];
  const ids = new Set<string>();
  const corrupt = (name: string, reason: string) =>
    new Error(`履歴ファイルが破損しています：${name}（${reason}）。元データを保全して復旧してください。`);
  for (const name of entries) {
    if (!FILE_PATTERN.test(name)) throw corrupt(name, "ファイル名が不正");
    let record: SceneHistoryRecord;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as SceneHistoryRecord;
    } catch {
      throw corrupt(name, "JSON として読めない");
    }
    if (typeof record !== "object" || record === null) throw corrupt(name, "記録が不正");
    if (record.revision !== records.length + 1 || Number(name.slice(0, 10)) !== record.revision)
      throw corrupt(name, `番号が ${records.length + 1} ではない`);
    if (typeof record.id !== "string" || !ID_PATTERN.test(record.id) || ids.has(record.id)) throw corrupt(name, "id が不正または重複");
    if (typeof record.label !== "string" || typeof record.timestamp !== "string") throw corrupt(name, "項目が不正");
    if (record.hash !== digest(record.project)) throw corrupt(name, "ハッシュ不一致");
    try {
      validateProject(record.project);
    } catch (error) {
      throw corrupt(name, error instanceof Error ? error.message : "検証失敗");
    }
    ids.add(record.id);
    records.push({ ...record, restoredFrom: record.restoredFrom ?? null });
  }
  return records;
}

export class SceneHistoryStore {
  private closed = false;

  private constructor(
    private readonly dir: string,
    private readonly now: () => Date,
    private readonly lockFd: number,
    private readonly records: SceneHistoryRecord[],
    private readonly byId: Map<string, SceneHistoryRecord>,
  ) {}

  static open(dir: string, now: () => Date = () => new Date()): SceneHistoryStore {
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = path.join(dir, LOCK_NAME);
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(`履歴の ${LOCK_NAME} が存在します。他のサーバーを終了してください。異常終了後は稼働していないことを確認し、このファイルだけを削除してください。`);
      throw error;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
      fs.fsyncSync(fd);
      const records = readRecords(dir);
      return new SceneHistoryStore(dir, now, fd, records, new Map(records.map((record) => [record.id, record])));
    } catch (error) {
      fs.closeSync(fd);
      fs.unlinkSync(lockPath);
      throw error;
    }
  }

  list(): SceneHistoryMeta[] {
    return this.records.map(toMeta);
  }

  get(revision: number): SceneHistoryRecord | null {
    if (!Number.isInteger(revision)) return null;
    const record = this.records[revision - 1];
    return record ? structuredClone(record) : null;
  }

  latest(): SceneHistoryRecord | null {
    return this.get(this.records.length);
  }

  append(input: AppendRequest): AppendResult {
    if (this.closed) throw new Error("scene history store is closed");
    const request = parseAppendRequest(input);
    let project: SceneProject;
    try {
      project = projectForSave(request.project as SceneProject);
    } catch (error) {
      return bad(`project is invalid: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    const hash = digest(project);
    const existing = this.byId.get(request.id);
    if (existing) {
      return existing.hash === hash
        ? { status: "duplicate", record: structuredClone(existing) }
        : { status: "conflict", latestRevision: this.records.length };
    }
    if (request.expectedRevision !== this.records.length) return { status: "conflict", latestRevision: this.records.length };
    const restoredFrom = request.restoredFrom ?? null;
    if (restoredFrom !== null && restoredFrom > this.records.length) bad("restoredFrom does not refer to an existing revision");

    const record: SceneHistoryRecord = {
      revision: this.records.length + 1, id: request.id, timestamp: this.now().toISOString(),
      label: request.label, restoredFrom, hash, project,
    };
    const target = path.join(this.dir, fileName(record.revision));
    const temporary = path.join(this.dir, `${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temporary, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify(record));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, target);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    this.records.push(record);
    this.byId.set(record.id, record);
    return { status: "created", record: structuredClone(record) };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    fs.closeSync(this.lockFd);
    fs.rmSync(path.join(this.dir, LOCK_NAME), { force: true });
  }
}
