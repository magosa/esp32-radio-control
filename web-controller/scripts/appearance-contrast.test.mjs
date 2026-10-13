import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import postcss from "postcss";
import { FLEET_PALETTES } from "../hooks/useFleetAppearance.ts";

const stylesheet = postcss.parse(readFileSync(new URL("../app/fleet/fleet.module.css", import.meta.url), "utf8"));
const themes = {};
stylesheet.walkRules((rule) => {
  if (rule.selector !== ".fleet" && rule.selector !== '.fleet[data-theme="dark"]') return;
  themes[rule.selector] = { ...themes[rule.selector], ...Object.fromEntries(rule.nodes.filter((node) => node.type === "decl" && node.prop.startsWith("--")).map((node) => [node.prop, node.value])) };
});

function color(value) {
  if (/^#[\da-f]{3,4}$/i.test(value)) value = `#${[...value.slice(1)].map((character) => character.repeat(2)).join("")}`;
  assert.match(value, /^#[\da-f]{6}([\da-f]{2})?$/i);
  const channels = [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  return [...channels, value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1];
}

function composite(front, back) {
  return front.slice(0, 3).map((channel, index) => channel * front[3] + back[index] * (1 - front[3]));
}

function saturate(channels) {
  const grey = channels[0] * .213 + channels[1] * .715 + channels[2] * .072;
  const amount = parseFloat(themes[".fleet"]["--glass-saturation"]) / 100;
  return channels.slice(0, 3).map((channel) => Math.max(0, Math.min(255, grey + (channel - grey) * amount)));
}

function luminance(channels) {
  return channels.slice(0, 3).reduce((sum, channel, index) => {
    const normalized = channel / 255;
    const linear = normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
    return sum + linear * [.2126, .7152, .0722][index];
  }, 0);
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (values[0] + .05) / (values[1] + .05);
}

for (const palette of FLEET_PALETTES) {
  for (const mode of ["light", "dark"]) {
    test(`${palette.label}: ${mode} text contrast`, () => {
      const tokens = {
        ...themes[".fleet"],
        ...(mode === "dark" ? themes['.fleet[data-theme="dark"]'] : {}),
        "--primary-500": palette.primary,
        "--primary-300": palette.light,
        "--primary-readable": palette.readable,
        "--primary-700": palette.dark,
        "--primary-ink": "text" in palette ? palette.text : palette.dark,
        "--primary-tint": palette.tint,
      };
      const resolve = (name) => {
        const value = tokens[name];
        return value.startsWith("var(") ? resolve(value.slice(4, -1)) : color(value);
      };
      const stops = (mode === "light" ? palette.backgroundLight : palette.backgroundDark).map(color);
      const backdropColors = ["--primary-300", "--primary-tint", "--backdrop-secondary"].map(resolve);
      const fills = ["--glass-top", "--glass-card", "--glass-bottom"].map(resolve);
      const opacity = Number(tokens["--backdrop-opacity"]);
      let minimum = Infinity;
      for (let segment = 0; segment < stops.length - 1; segment++) {
        for (let step = 0; step <= 100; step++) {
          const base = stops[segment].slice(0, 3).map((channel, index) => channel + (stops[segment + 1][index] - channel) * step / 100);
          const backdrops = [base, composite([0, 0, 0, .02], base), composite([255, 255, 255, opacity], base), ...backdropColors.map((tint) => composite([...tint.slice(0, 3), opacity], base))];
          for (const backdrop of backdrops) {
            const warning = composite(resolve("--warning"), saturate(backdrop));
            for (const grain of [[0, 0, 0, 4 / 255], [255, 255, 255, 4 / 255]]) {
              const ratio = contrast(resolve("--warning-ink"), composite(grain, warning));
              minimum = Math.min(minimum, ratio);
              assert.ok(ratio >= 4.5, `--warning-ink: ${ratio.toFixed(2)}:1`);
            }
            const sidebar = composite(resolve("--glass-sidebar"), saturate(backdrop));
            const backgrounds = [backdrop, sidebar];
            for (const fill of fills) {
              const card = composite(fill, saturate(backdrop));
              const glow = composite(resolve("--glass-glow"), card);
              const vehicle = composite(fill, saturate(sidebar));
              backgrounds.push(card, glow, vehicle, composite(resolve("--glass-glow"), vehicle), composite(resolve("--glass-input"), saturate(card)), composite(resolve("--surface"), saturate(card)), composite(resolve("--selected"), card));
            }
            for (const background of backgrounds) {
              for (const grain of [[0, 0, 0, 4 / 255], [255, 255, 255, 4 / 255]]) {
                const textured = composite(grain, background);
                for (const ink of ["--ink", "--muted", "--accent"]) {
                  const ratio = contrast(resolve(ink), textured);
                  minimum = Math.min(minimum, ratio);
                  assert.ok(ratio >= 4.5, `${ink}: ${ratio.toFixed(2)}:1`);
                }
              }
            }
          }
        }
      }
      assert.ok(contrast(resolve("--accent-ink"), resolve("--action")) >= 4.5);
      console.log(`${palette.id}/${mode}: minimum ${minimum.toFixed(2)}:1`);
    });
  }
}