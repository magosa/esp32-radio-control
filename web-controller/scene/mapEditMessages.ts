const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff]/;

const EXACT: ReadonlyArray<readonly [string, string]> = [
  ["click near a wall", "ドアを置く壁の近くをクリックしてください。"],
  ["doors on the same wall must not overlap", "同じ壁のドアが重なっています。"],
  ["only one door per wall edge", "同じ辺にはドアを1つだけ置けます。"],
  ["door must lie within its wall", "ドアが壁の範囲をはみ出しています。"],
  ["gates must be dragged as a rectangle", "ゲートは長方形でドラッグしてください。"],
  ["the whole gate must lie inside the same room or corridor", "ゲート全体を同じ部屋または廊下の内側に置いてください。"],
  ["gates must not overlap furniture", "ゲートは家具と重ねて置けません。"],
  ["gates must not overlap existing walls or gates", "ゲートは既存の壁やゲートと重ねて置けません。"],
  ["furniture must lie entirely within one room", "家具は1つの領域の内側に置いてください。"],
  ["only one furniture item per cell", "他の家具と重なっています。同じマスに家具は1つだけ置けます。"],
  ["rotated furniture goes outside the map", "回転すると家具が地図の外に出ます。"],
  ["charging zone must lie inside the area", "充電スペースは地図の内側に置いてください。"],
  ["charging zones must be an array of at most 64", "充電スペースは64件までです。"],
  ["floor plan has too many", "ドア・家具・壁の数が上限を超えています。"],
];

const PATTERNS: ReadonlyArray<readonly [RegExp, (match: RegExpMatchArray) => string]> = [
  [/automatic doors need a continuous (\d+)-cell \((\d+)mm\) wall/, (m) => `独立した壁に、${m[1]}マス(${m[2]}mm)以上の連続した長さが必要です。`],
  [/automatic doors need (\d+) contiguous cells on the same outer edge/, (m) => `ドアの幅(${m[1]}マス)に必要な連続した外周がありません。`],
  [/the (\d+) door cells must face the same adjacent region/, () => "ドアの全幅が、同じ隣の領域に面していません。"],
  [/gate entrance must be (\d+)-(\d+) cells/, (m) => `ゲートの入口幅は${m[1]}〜${m[2]}マスにしてください。`],
  [/cannot fit a (\d+)-cell entrance/, (m) => `入口幅${m[1]}マスが地図に収まりません。範囲内からドラッグしてください。`],
  [/^(wall|door) must be a horizontal or vertical segment inside the area/, () => "壁は地図の内側に、水平または垂直に置いてください。"],
];

/** Maps the English errors thrown by the scene validators to Japanese. Japanese messages pass through. */
export function toJapanese(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (JAPANESE.test(message)) return message;
  for (const [needle, text] of EXACT) if (message.includes(needle)) return text;
  for (const [pattern, build] of PATTERNS) {
    const match = message.match(pattern);
    if (match) return build(match);
  }
  return `この操作はできません。(${message})`;
}
