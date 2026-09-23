/** SHOTS=1: render the sprite sheet to .cache/shots/sprites.png for visual review. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { Framebuffer } from "../../src/render/fb";
import { BIG, SMALL, text } from "../../src/render/font";
import { C } from "../../src/render/palette";
import * as S from "../../src/render/sprites";
import { writePng } from "../support/png";

it.runIf(process.env.SHOTS)("sprite sheet", () => {
  const fb = new Framebuffer(320, 200);
  fb.clear(C.void);
  let x = 4;
  for (const d of ["N", "E", "S", "W"] as const) {
    fb.blit(S.floorTile(1, 1), x, 4);
    fb.blit(S.robotSprite(d, 0), x, 4);
    fb.blit(S.floorTile(2, 1), x, 22);
    fb.blit(S.robotSprite(d, 1, "red"), x, 22);
    fb.blit(S.floorTile(3, 1), x, 40);
    fb.blit(S.forkliftSprite(d, true), x, 40);
    x += 18;
  }
  const tiles = [S.floorTile(0, 0), S.floorTile(1, 0), S.wallTile(0, 0, true, false), S.wallTile(1, 0, false, false), S.shelfTile(0, 0, { N: false, E: true, S: false, W: false }), S.shelfTile(1, 0, { N: false, E: false, S: false, W: true }), S.crateTile(0, 0), S.chargerTile(0, 0, 1), S.dockTile(0, 0, 1, 0), S.dockTile(0, 0, 2, 0), S.dockTile(0, 0, 3, 0), S.pickupTile(0, 0), S.spillTile(0, 0, 0)];
  tiles.forEach((t, i) => fb.blit(t, 4 + (i % 8) * 18, 62 + Math.floor(i / 8) * 18));
  (["LOW", "NORMAL", "HIGH", "URGENT"] as const).forEach((p, i) => {
    fb.blit(S.packageSprite(p), 160 + i * 12, 4);
    fb.blit(S.packageSprite(p, true), 160 + i * 12, 14);
  });
  Object.values(S.ICONS).forEach((ic, i) => fb.blit(ic, 160 + i * 10, 26));
  text(fb, BIG, "JEB // DEPOT 0123456789", 4, 110, C.cyan);
  text(fb, BIG, "THE QUICK BROWN FOX: 42% ←↑→↓ ▶ Ⅱ ✓", 4, 122, C.white);
  text(fb, SMALL, "SMALL FONT: LATENCY P95 101MS / CONF 83% ←↑→↓", 4, 134, C.mist);
  text(fb, SMALL, "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 .,:;!?-+=/()%#", 4, 142, C.amber);
  const out = path.resolve(import.meta.dirname, "../../.cache/shots");
  mkdirSync(out, { recursive: true });
  writePng(path.join(out, "sprites.png"), fb.data, fb.w, fb.h, 4);
});
