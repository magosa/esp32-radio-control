import type { IncomingMessage, ServerResponse } from "node:http";
import { SceneHistoryError, parseAppendRequest, type SceneHistoryStore } from "./sceneHistoryStore";

export const MAX_BODY_BYTES = 10 * 1024 * 1024;

const PREFIX = "/api/scenes/";
const REVISION_ROUTE = /^\/api\/scenes\/history\/([1-9]\d{0,9})$/;
const JSON_TYPE = /^application\/json\s*(?:;\s*charset=utf-?8\s*)?$/i;

function send(res: ServerResponse, status: number, body?: unknown, extra: Record<string, string> = {}): void {
  const headers: Record<string, string | number> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra };
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length });
  res.end(payload);
}

// 書き込みは同一オリジンのページからだけ許可する（Origin のホストが Host と一致）。
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== "string" || typeof host !== "string" || host === "") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.origin.toLowerCase() !== origin.toLowerCase()) return false;
  return url.host.toLowerCase() === host.toLowerCase();
}

// 上限を超えたら保持をやめて null を返す。残りは破棄しつつ読み流し、上限の 2 倍に達したら接続を切る。
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const drainLimit = MAX_BODY_BYTES * 2;
  const declared = Number(req.headers["content-length"]);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    const overflow = () => {
      tooLarge = true;
      chunks.length = 0;
      resolve(null);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > drainLimit) req.destroy();
      else if (!tooLarge && size > MAX_BODY_BYTES) overflow();
      else if (!tooLarge) chunks.push(chunk);
    });
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) overflow();
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("close", () => {
      if (!req.complete) reject(new Error("request aborted"));
    });
  });
}

async function handlePost(req: IncomingMessage, res: ServerResponse, store: SceneHistoryStore): Promise<void> {
  if (!isSameOrigin(req)) return send(res, 403, { error: "cross-origin writes are not allowed" });
  const type = req.headers["content-type"];
  if (typeof type !== "string" || !JSON_TYPE.test(type.trim())) return send(res, 415, { error: "Content-Type must be application/json" });

  const raw = await readBody(req);
  if (raw === null) return send(res, 413, { error: `request body must be at most ${MAX_BODY_BYTES} bytes` });

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return send(res, 400, { error: "request body must be valid UTF-8 JSON" });
  }
  try {
    const result = store.append(parseAppendRequest(parsed));
    if (result.status === "conflict") return send(res, 409, { error: "revision conflict", latestRevision: result.latestRevision });
    return send(res, result.status === "created" ? 201 : 200, result.record);
  } catch (error) {
    if (error instanceof SceneHistoryError) return send(res, 400, { error: error.message });
    throw error;
  }
}

// /api/scenes/ 以外は false を返し、呼び出し側が Next に渡す。
export async function handleSceneRequest(req: IncomingMessage, res: ServerResponse, store: SceneHistoryStore): Promise<boolean> {
  const pathname = (req.url ?? "").split("?")[0];
  if (!pathname.startsWith(PREFIX)) return false;
  try {
    const method = req.method ?? "GET";
    const revision = REVISION_ROUTE.exec(pathname);
    if (pathname === "/api/scenes/history") {
      if (method === "GET") send(res, 200, { records: store.list() });
      else if (method === "POST") await handlePost(req, res, store);
      else send(res, 405, { error: "method not allowed" }, { Allow: "GET, POST" });
    } else if (pathname === "/api/scenes/latest") {
      if (method !== "GET") send(res, 405, { error: "method not allowed" }, { Allow: "GET" });
      else {
        const latest = store.latest();
        if (latest) send(res, 200, latest);
        else send(res, 204);
      }
    } else if (revision) {
      if (method !== "GET") send(res, 405, { error: "method not allowed" }, { Allow: "GET" });
      else {
        const record = store.get(Number(revision[1]));
        if (record) send(res, 200, record);
        else send(res, 404, { error: "revision not found" });
      }
    } else {
      send(res, 404, { error: "not found" });
    }
  } catch (error) {
    console.error("[scene-http]", error);
    if (res.headersSent || res.destroyed) res.destroy();
    else send(res, 500, { error: "internal error" });
  }
  return true;
}
