// 測位用WebSocket(/ws/localizer)へ接続できるのは、Hubと同じPCのHubページ(localhost系Origin)だけ。
// 偽の姿勢を送られると閉ループ走行を操作されるため、外部サイトのスクリプトからの接続も遮断する。
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isTrustedLocalizerRequest(
  request: { headers: { origin?: string | string[] }; socket: { remoteAddress?: string } },
  port: number,
  allowRemote = false,
): boolean {
  if (allowRemote) return true;
  const origin = request.headers.origin;
  if (typeof origin !== "string") return false;
  const allowedOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
  return LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? "") && allowedOrigins.includes(origin);
}
