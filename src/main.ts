/**
 * Entry point: a 480x270 framebuffer, integer-scaled to the window with nearest-neighbour filtering,
 * redrawn every animation frame.
 */
import { App } from "./app/app";
import { createBackend } from "./platform/backend";
import { Framebuffer, SCREEN_H, SCREEN_W } from "./render/fb";
import { Input } from "./ui/input";
import { UI } from "./ui/widgets";

const canvas = document.getElementById("screen") as HTMLCanvasElement;
const stage = document.getElementById("stage") as HTMLDivElement;
const ctx = canvas.getContext("2d", { alpha: false }) as CanvasRenderingContext2D;
const fb = new Framebuffer(SCREEN_W, SCREEN_H);
const image = new ImageData(new Uint8ClampedArray(fb.data.buffer as ArrayBuffer), SCREEN_W, SCREEN_H);

let scale = 1;
function layout(): void {
  // Largest integer scale that fits: every logical pixel is an exact square of screen pixels.
  scale = Math.max(1, Math.floor(Math.min(window.innerWidth / SCREEN_W, window.innerHeight / SCREEN_H)));
  const w = SCREEN_W * scale;
  const h = SCREEN_H * scale;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  stage.style.setProperty("--px", `${scale}px`);
}
window.addEventListener("resize", layout);
layout();

const input = new Input(canvas, (cx, cy) => {
  const r = canvas.getBoundingClientRect();
  return { x: Math.floor(((cx - r.left) / r.width) * SCREEN_W), y: Math.floor(((cy - r.top) / r.height) * SCREEN_H) };
});
const ui = new UI(fb, input);
const backend = createBackend();
const app = new App(backend);

let last = performance.now();
let reported = false;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  app.frame(ui, dt);
  input.endFrame();
  ctx.putImageData(image, 0, 0);
  canvas.style.cursor = ui.pointer ? "pointer" : "default";
  if (!reported) {
    reported = true;
    void backend.frontendReady().catch(() => undefined);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Debug hook for the developer console (not used by the game).
(window as unknown as { jebDepot: App }).jebDepot = app;
