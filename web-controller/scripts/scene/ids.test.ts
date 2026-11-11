import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { defaultId } from "../../scene/ids";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function withCrypto<T>(replacement: unknown, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: replacement, configurable: true, writable: true });
  try { return run(); } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original); else delete (globalThis as { crypto?: unknown }).crypto;
  }
}

test("defaultId returns a v4 UUID", () => {
  assert.match(defaultId(), UUID_V4);
});

test("defaultId works without crypto.randomUUID (plain-http pages have only getRandomValues)", () => {
  const insecure = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
  const ids = withCrypto(insecure, () => Array.from({ length: 500 }, () => defaultId()));
  for (const id of ids) assert.match(id, UUID_V4);
  assert.equal(new Set(ids).size, ids.length);
});

test("defaultId sets the version and variant bits even for an all-ones random source", () => {
  const fixed = { getRandomValues: (a: Uint8Array) => { a.fill(0xff); return a; } };
  assert.equal(withCrypto(fixed, () => defaultId()), "ffffffff-ffff-4fff-bfff-ffffffffffff");
});
