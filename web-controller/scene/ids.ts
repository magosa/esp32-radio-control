export type IdFactory = () => string;

const HEX = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));

// crypto.randomUUID は https/localhost 限定。LAN の IP で http 接続した画面では getRandomValues だけが使える。
export const defaultId: IdFactory = () => {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = (from: number, to: number) => Array.from(b.subarray(from, to), (x) => HEX[x]).join("");
  return `${h(0, 4)}-${h(4, 6)}-${h(6, 8)}-${h(8, 10)}-${h(10, 16)}`;
};
