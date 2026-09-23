/** Sparks on collisions, confetti on deliveries, dust behind wheels, floating score text. */
import type { Framebuffer } from "./fb";
import { BIG, SMALL, text } from "./font";
import { C, withAlpha } from "./palette";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: number;
  gravity: number;
  size: number;
}

interface Floater {
  x: number;
  y: number;
  text: string;
  color: number;
  life: number;
  max: number;
  big: boolean;
}

export class Particles {
  private ps: Particle[] = [];
  private fs: Floater[] = [];
  /** Screen shake amplitude in px, decays. */
  shake = 0;
  private seed = 12345;

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
    return (this.seed >>> 8) / 16777216;
  }

  burst(x: number, y: number, n: number, colors: readonly number[], opts: { speed?: number; gravity?: number; life?: number; up?: boolean; size?: number } = {}): void {
    for (let i = 0; i < n; i++) {
      const a = opts.up ? -Math.PI / 2 + (this.rand() - 0.5) * 2.2 : this.rand() * Math.PI * 2;
      const s = (opts.speed ?? 40) * (0.4 + this.rand() * 0.8);
      const life = (opts.life ?? 0.6) * (0.6 + this.rand() * 0.6);
      this.ps.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, color: colors[Math.floor(this.rand() * colors.length)] as number, gravity: opts.gravity ?? 0, size: opts.size ?? 1 });
    }
  }

  sparks(x: number, y: number): void {
    this.burst(x, y, 18, [C.yellow, C.amber, C.white], { speed: 70, gravity: 120, life: 0.45 });
    this.shake = Math.max(this.shake, 2.5);
  }

  confetti(x: number, y: number): void {
    this.burst(x, y, 34, [C.cyan, C.magenta, C.yellow, C.green, C.amber, C.white], { speed: 60, gravity: 70, life: 1.1, up: true });
  }

  dust(x: number, y: number): void {
    this.burst(x, y, 2, [C.floor3, C.line], { speed: 8, life: 0.35 });
  }

  zap(x: number, y: number): void {
    this.burst(x, y, 3, [C.cyan, C.white], { speed: 25, life: 0.25 });
  }

  float(x: number, y: number, s: string, color: number, big = false): void {
    this.fs.push({ x, y, text: s, color, life: 1.3, max: 1.3, big });
  }

  update(dt: number): void {
    for (const p of this.ps) {
      p.life -= dt;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 2.5 * dt;
    }
    this.ps = this.ps.filter((p) => p.life > 0);
    for (const f of this.fs) {
      f.life -= dt;
      f.y -= 14 * dt;
    }
    this.fs = this.fs.filter((f) => f.life > 0);
    this.shake = Math.max(0, this.shake - dt * 10);
  }

  draw(fb: Framebuffer, ox: number, oy: number): void {
    for (const p of this.ps) {
      const a = Math.min(1, (p.life / p.max) * 1.5);
      fb.rect(ox + p.x, oy + p.y, p.size, p.size, withAlpha(p.color, a * 255));
    }
    for (const f of this.fs) {
      const a = Math.min(1, (f.life / f.max) * 2);
      if (a < 0.5 && Math.floor(f.life * 20) % 2) continue;
      text(fb, f.big ? BIG : SMALL, f.text, ox + f.x, oy + f.y, f.color, { align: "center" });
    }
  }

  clear(): void {
    this.ps = [];
    this.fs = [];
    this.shake = 0;
  }
}
