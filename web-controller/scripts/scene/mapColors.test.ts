import assert from "node:assert/strict";
import test from "node:test";
import { FLOOR_MATERIALS, FURNITURE_TYPES, MAP_COLORS, ROOM_KINDS } from "../../scene/mapColors";

const HEX = /^#[0-9a-f]{6}$/i;

function collect(value: unknown, path: string, out: [string, unknown][] = []): [string, unknown][] {
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) collect(child, `${path}.${key}`, out);
  } else {
    out.push([path, value]);
  }
  return out;
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("every map colour is a fixed #rrggbb hex", () => {
  const leaves = collect(MAP_COLORS, "MAP_COLORS");
  assert.ok(leaves.length > 0);
  for (const [path, value] of leaves) {
    assert.equal(typeof value, "string", path);
    assert.match(value as string, HEX, path);
  }
});

test("every material, room kind and furniture type has a colour", () => {
  for (const material of FLOOR_MATERIALS) assert.match(MAP_COLORS.floor[material], HEX, material);
  for (const kind of ROOM_KINDS) assert.match(MAP_COLORS.roomKind[kind], HEX, kind);
  for (const type of FURNITURE_TYPES) assert.match(MAP_COLORS.furniture[type], HEX, type);
  assert.deepEqual(Object.keys(MAP_COLORS.floor).sort(), [...FLOOR_MATERIALS].sort());
  assert.deepEqual(Object.keys(MAP_COLORS.furniture).sort(), [...FURNITURE_TYPES].sort());
});

test("robot body and walls keep 3:1 contrast against every floor", () => {
  for (const material of FLOOR_MATERIALS) {
    const floor = MAP_COLORS.floor[material];
    assert.ok(contrast(MAP_COLORS.robotBody, floor) >= 3, `robotBody vs ${material}`);
    assert.ok(contrast(MAP_COLORS.wall, floor) >= 3, `wall vs ${material}`);
  }
});
