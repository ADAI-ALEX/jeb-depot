/**
 * The whole game draws from this limited palette: control-room navies and steels, warm concrete, rack orange,
 * crate wood, and restrained neon accents (cyan = JEB, amber = caution, magenta/red = danger, green = OK).
 * Colours are packed as 0xAABBGGRR for a little-endian Uint32 view of RGBA image data.
 */
export function rgba(hex: string, alpha = 255): number {
  const v = parseInt(hex.replace("#", ""), 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return ((alpha << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export const HEX = {
  void: "#07090f",
  ink: "#0b0e1a",
  panel: "#111729",
  panel2: "#18203a",
  panel3: "#222d4d",
  edge: "#2f3d63",
  steel: "#415580",
  steel2: "#5a74a3",
  steel3: "#88a2cc",
  mist: "#b9c9e6",
  white: "#eef4ff",
  floor0: "#1f2332",
  floor1: "#282e3f",
  floor2: "#30374b",
  floor3: "#3a4259",
  line: "#454d66",
  rack: "#c4562a",
  rack2: "#e57e3a",
  wood0: "#5a3b24",
  wood1: "#7d5431",
  wood2: "#a4733f",
  wood3: "#cf9a5a",
  cyan: "#3ee6ff",
  cyan2: "#1ea4c9",
  cyan3: "#0e5b7c",
  amber: "#ffb43b",
  amber2: "#bb7419",
  yellow: "#ffe45a",
  green: "#5cf08e",
  green2: "#2a9a57",
  red: "#ff4e62",
  red2: "#a52538",
  magenta: "#ff55b0",
  magenta2: "#a8307a",
  blue: "#4f8bff",
  blue2: "#2a4ea8",
  oil0: "#120f1c",
  oil1: "#241d38",
  oil2: "#4a3c7a",
  black: "#000000",
} as const;

export type ColorName = keyof typeof HEX;

export const C = Object.fromEntries(Object.entries(HEX).map(([k, v]) => [k, rgba(v)])) as Record<ColorName, number>;

export const TRANSPARENT = 0;

export function withAlpha(c: number, a: number): number {
  return ((c & 0x00ffffff) | ((Math.max(0, Math.min(255, Math.round(a))) & 255) << 24)) >>> 0;
}

/** Linear mix of two packed colours (t = 0 -> a, 1 -> b), opaque result. */
export function mix(a: number, b: number, t: number): number {
  const u = 1 - t;
  const r = (a & 255) * u + (b & 255) * t;
  const g = ((a >> 8) & 255) * u + ((b >> 8) & 255) * t;
  const bl = ((a >> 16) & 255) * u + ((b >> 16) & 255) * t;
  return ((255 << 24) | (Math.round(bl) << 16) | (Math.round(g) << 8) | Math.round(r)) >>> 0;
}

/** Priority colours for packages and HUD tags. */
export const PRIORITY_COLOR = { LOW: C.steel3, NORMAL: C.cyan, HIGH: C.amber, URGENT: C.magenta } as const;
export const DOCK_COLOR: Record<number, [number, number]> = { 1: [C.red, C.red2], 2: [C.blue, C.blue2], 3: [C.green, C.green2] };
