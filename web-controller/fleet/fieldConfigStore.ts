import fs from "node:fs";
import path from "node:path";
import type { FieldConfig } from "./protocol";

// node-localizerの初期値(領域は16:9の概算寸法)。
export const DEFAULT_FIELD_CONFIG: FieldConfig = {
  cameraHeightMm: 800, widthMm: 1106.93, heightMm: 622.65, referenceSizeMm: 33,
};

export function isFieldConfig(value: unknown): value is FieldConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as FieldConfig;
  const valid = (n: unknown, max: number) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= max;
  return valid(config.cameraHeightMm, 10000) && valid(config.widthMm, 20000)
    && valid(config.heightMm, 20000) && valid(config.referenceSizeMm, 1000);
}

// 俯瞰カメラ・走行領域の設定をdata/field.jsonに原子的に保存する。
export class FieldConfigStore {
  private config: FieldConfig = { ...DEFAULT_FIELD_CONFIG };

  constructor(private filePath: string) {
    if (!fs.existsSync(filePath)) return;
    const loaded = JSON.parse(fs.readFileSync(filePath, "utf8")) as { version?: number; config?: unknown };
    if (loaded.version !== 1 || !isFieldConfig(loaded.config)) throw new Error("Invalid field configuration");
    this.config = loaded.config;
  }

  get(): FieldConfig {
    return { ...this.config };
  }

  set(config: FieldConfig): void {
    if (!isFieldConfig(config)) throw new Error("Invalid field configuration");
    const next: FieldConfig = {
      cameraHeightMm: config.cameraHeightMm, widthMm: config.widthMm,
      heightMm: config.heightMm, referenceSizeMm: config.referenceSizeMm,
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, config: next }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
    this.config = next;
  }
}
