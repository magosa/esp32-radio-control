"use client";

import { useEffect, useState, type CSSProperties } from "react";

export const FLEET_PALETTES = [
  { id: "ocean", label: "Ocean Blue", primary: "#3B82F6", light: "#93C5FD", readable: "#DBEAFE", dark: "#1D4ED8", tint: "#60A5FA", text: "#1E40AF", backgroundLight: ["#E0F2FE", "#DBEAFE", "#EDE9FE"], backgroundDark: ["#0F172A", "#1E293B", "#312E81"] },
  { id: "lavender", label: "Lavender Purple", primary: "#8B5CF6", light: "#C4B5FD", readable: "#EDE9FE", dark: "#6D28D9", tint: "#A78BFA", text: "#5B21B6", backgroundLight: ["#F3E8FF", "#EDE9FE", "#FCE7F3"], backgroundDark: ["#151025", "#241A40", "#312E55"] },
  { id: "mint", label: "Mint Green", primary: "#10B981", light: "#6EE7B7", readable: "#D1FAE5", dark: "#047857", tint: "#34D399", text: "#065F46", backgroundLight: ["#D1FAE5", "#E0F2FE", "#E4F4ED"], backgroundDark: ["#091B18", "#132B29", "#203331"] },
  { id: "rose", label: "Rose Pink", primary: "#EC4899", light: "#F9A8D4", readable: "#FCE7F3", dark: "#BE185D", tint: "#F472B6", text: "#831843", backgroundLight: ["#FCE7F3", "#FFE4E6", "#EDE9FE"], backgroundDark: ["#20111D", "#322031", "#3D2131"] },
  { id: "sunset", label: "Sunset Amber", primary: "#F59E0B", light: "#FCD34D", readable: "#FEF3C7", dark: "#B45309", tint: "#FBBF24", text: "#92400E", backgroundLight: ["#FEF3C7", "#FFEDD5", "#FCE7F3"], backgroundDark: ["#1F1713", "#252422", "#2F2630"] },
] as const;

export type FleetAppearance = {
  theme: "system" | "light" | "dark";
  palette: typeof FLEET_PALETTES[number]["id"];
  motion: boolean;
};

export const DEFAULT_FLEET_APPEARANCE: FleetAppearance = { theme: "system", palette: "ocean", motion: true };
const STORAGE_KEY = "fleet-appearance";
const CHANGE_EVENT = "fleet-appearance-change";

function validateAppearance(value: unknown): FleetAppearance {
  if (!value || typeof value !== "object") return DEFAULT_FLEET_APPEARANCE;
  const candidate = value as Partial<FleetAppearance>;
  return {
    theme: candidate.theme === "light" || candidate.theme === "dark" ? candidate.theme : "system",
    palette: FLEET_PALETTES.find((palette) => palette.id === candidate.palette)?.id ?? "ocean",
    motion: typeof candidate.motion === "boolean" ? candidate.motion : true,
  };
}

function readAppearance(): FleetAppearance {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) return validateAppearance(JSON.parse(saved));
    const legacyTheme = window.localStorage.getItem("fleet-theme");
    return { ...DEFAULT_FLEET_APPEARANCE, theme: legacyTheme === "light" || legacyTheme === "dark" ? legacyTheme : "system" };
  } catch {
    return DEFAULT_FLEET_APPEARANCE;
  }
}

export function useFleetAppearance() {
  const [appearance, setAppearance] = useState<FleetAppearance>(DEFAULT_FLEET_APPEARANCE);
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    setAppearance(readAppearance());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => setSystemDark(media.matches);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === "fleet-theme" || event.key === null) setAppearance(readAppearance());
    };
    const onChange = (event: Event) => setAppearance(validateAppearance((event as CustomEvent).detail));
    onSystemChange();
    media.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
      media.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, []);

  const updateAppearance = (patch: Partial<FleetAppearance>): boolean => {
    const next = validateAppearance({ ...appearance, ...patch });
    setAppearance(next);
    let saved = true;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      saved = false;
    }
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
    return saved;
  };

  const theme = appearance.theme === "system" ? (systemDark ? "dark" : "light") : appearance.theme;
  const palette = FLEET_PALETTES.find((item) => item.id === appearance.palette)!;
  const style = {
    "--primary-500": palette.primary,
    "--primary-300": palette.light,
    "--primary-readable": palette.readable,
    "--primary-700": palette.dark,
    "--primary-ink": palette.text,
    "--primary-tint": palette.tint,
    "--bg-light": `linear-gradient(135deg, ${palette.backgroundLight.join(", ")})`,
    "--bg-dark": `linear-gradient(135deg, ${palette.backgroundDark.join(", ")})`,
  } as CSSProperties;

  return { appearance, theme, style, updateAppearance };
}