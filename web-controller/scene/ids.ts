export type IdFactory = () => string;

function fallbackStructuredClone<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return seen.get(value as object) as T;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (value instanceof RegExp) return new RegExp(value.source, value.flags) as unknown as T;
  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length);
    seen.set(value, copy);
    for (let i = 0; i < value.length; i++) copy[i] = fallbackStructuredClone(value[i], seen);
    return copy as unknown as T;
  }
  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    value.forEach((v, k) => copy.set(fallbackStructuredClone(k, seen), fallbackStructuredClone(v, seen)));
    return copy as unknown as T;
  }
  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    value.forEach((v) => copy.add(fallbackStructuredClone(v, seen)));
    return copy as unknown as T;
  }
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) as unknown as T;
    }
    const TypedArray = value.constructor as { new (buffer: ArrayBufferLike): ArrayBufferView };
    return new TypedArray(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) as unknown as T;
  }
  if (value instanceof ArrayBuffer) return value.slice(0) as unknown as T;
  const proto = Object.getPrototypeOf(value);
  const copy = proto === null ? Object.create(null) : {};
  seen.set(value as object, copy);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    Object.defineProperty(copy, key, {
      value: fallbackStructuredClone((value as Record<string, unknown>)[key], seen),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return copy as T;
}

export function ensureRuntimePolyfills(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.structuredClone !== "function") {
    g.structuredClone = <T>(value: T): T => fallbackStructuredClone(value);
  }
  if (typeof Object.hasOwn !== "function") {
    Object.defineProperty(Object, "hasOwn", {
      value: (obj: object, prop: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(obj, prop),
      writable: true,
      configurable: true,
    });
  }
  if (typeof Array.prototype.at !== "function") {
    Object.defineProperty(Array.prototype, "at", {
      value: function <T>(this: T[], index: number): T | undefined {
        const len = this.length;
        const n = Math.trunc(index) || 0;
        const k = n >= 0 ? n : len + n;
        return k < 0 || k >= len ? undefined : this[k];
      },
      writable: true,
      configurable: true,
    });
  }
  if (typeof Array.prototype.findLast !== "function") {
    Object.defineProperty(Array.prototype, "findLast", {
      value: function <T>(this: T[], predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: unknown): T | undefined {
        for (let i = this.length - 1; i >= 0; i--) {
          if (predicate.call(thisArg, this[i], i, this)) return this[i];
        }
        return undefined;
      },
      writable: true,
      configurable: true,
    });
  }
  if (typeof Array.prototype.findLastIndex !== "function") {
    Object.defineProperty(Array.prototype, "findLastIndex", {
      value: function <T>(this: T[], predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: unknown): number {
        for (let i = this.length - 1; i >= 0; i--) {
          if (predicate.call(thisArg, this[i], i, this)) return i;
        }
        return -1;
      },
      writable: true,
      configurable: true,
    });
  }
}

ensureRuntimePolyfills();

const HEX = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));

// crypto.randomUUID は https/localhost 限定。LAN の IP で http 接続した画面や旧環境でも動作するようフォールバックする。
export const defaultId: IdFactory = () => {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(b);
  } else {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = (from: number, to: number) => Array.from(b.subarray(from, to), (x) => HEX[x]).join("");
  return `${h(0, 4)}-${h(4, 6)}-${h(6, 8)}-${h(8, 10)}-${h(10, 16)}`;
};
