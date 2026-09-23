/** ICON=1: draw the 32x32 pixel-art app icon and write a 1024 px PNG for `tauri icon`. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { Framebuffer } from "../../src/render/fb";
import { C, mix } from "../../src/render/palette";
import { writePng } from "../support/png";

export function drawIcon(fb: Framebuffer): void {
  fb.clear(0);
  // badge: rounded square, dark gradient, cyan rim
  const inside = (x: number, y: number, r: number, x0: number, y0: number, x1: number, y1: number): boolean => {
    const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
    const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      if (!inside(x + 0.5, y + 0.5, 6, 1, 1, 31, 31)) continue;
      const rim = !inside(x + 0.5, y + 0.5, 5, 2, 2, 30, 30);
      fb.px(x, y, rim ? C.cyan2 : mix(C.panel2, C.ink, y / 40));
    }
  // floor glow
  for (let x = 6; x < 26; x++) fb.px(x, 25, mix(C.panel2, C.cyan3, 0.6));
  // antenna
  fb.rect(15, 5, 2, 3, C.steel2);
  fb.rect(14, 3, 4, 2, C.amber);
  fb.px(15, 3, C.yellow);
  // shell
  fb.rect(8, 8, 16, 15, C.ink);
  fb.rect(9, 8, 14, 15, C.mist);
  fb.rect(8, 9, 16, 13, C.mist);
  fb.rect(10, 9, 12, 2, C.white);
  fb.rect(9, 19, 14, 3, C.steel3);
  // visor with eyes
  fb.rect(10, 12, 12, 6, C.ink);
  fb.rect(11, 13, 10, 4, C.cyan3);
  fb.rect(12, 14, 3, 2, C.cyan);
  fb.rect(17, 14, 3, 2, C.cyan);
  fb.px(12, 14, C.white);
  fb.px(17, 14, C.white);
  // treads
  fb.rect(6, 12, 2, 10, C.ink);
  fb.rect(24, 12, 2, 10, C.ink);
  for (let y = 12; y < 22; y += 2) {
    fb.px(6, y, C.floor3);
    fb.px(25, y, C.floor3);
  }
  // tail lights
  fb.px(10, 21, C.amber);
  fb.px(21, 21, C.amber);
}

it.runIf(process.env.ICON)("app icon", () => {
  const fb = new Framebuffer(32, 32);
  drawIcon(fb);
  const out = path.resolve(import.meta.dirname, "../../src-tauri/icons");
  mkdirSync(out, { recursive: true });
  writePng(path.join(out, "app-icon.png"), fb.data, 32, 32, 32);
  writePng(path.resolve(import.meta.dirname, "../../.cache/shots/icon.png"), fb.data, 32, 32, 8);
});
