/** Mouse and keyboard, in logical screen pixels (480 x 270), sampled once per frame. */
export class Input {
  mx = -1;
  my = -1;
  down = false;
  pressed = false;
  released = false;
  wheel = 0;
  readonly held = new Set<string>();
  private keys: string[] = [];
  /** Key presses consumed this frame (so one press does not trigger two widgets). */
  private consumed = new Set<string>();

  constructor(
    target: HTMLElement,
    private toLogical: (clientX: number, clientY: number) => { x: number; y: number },
  ) {
    target.addEventListener("mousemove", (e) => this.move(e));
    target.addEventListener("mousedown", (e) => {
      this.move(e);
      if (e.button === 0) {
        this.down = true;
        this.pressed = true;
      }
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) {
        this.down = false;
        this.released = true;
      }
    });
    target.addEventListener("mouseleave", () => {
      this.mx = -1;
      this.my = -1;
    });
    target.addEventListener("wheel", (e) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
    window.addEventListener("keydown", (e) => {
      if (e.metaKey) return; // leave Cmd shortcuts (Cmd+Q) to the system
      this.keys.push(e.code);
      this.held.add(e.code);
      if (e.code.startsWith("Arrow") || e.code === "Space" || e.code === "Tab") e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.held.delete(e.code));
    window.addEventListener("blur", () => this.held.clear());
  }

  private move(e: MouseEvent): void {
    const p = this.toLogical(e.clientX, e.clientY);
    this.mx = p.x;
    this.my = p.y;
  }

  /** True once per physical press of any of the given key codes. */
  key(...codes: string[]): boolean {
    for (const c of codes) {
      if (this.keys.includes(c) && !this.consumed.has(c)) {
        this.consumed.add(c);
        return true;
      }
    }
    return false;
  }

  within(x: number, y: number, w: number, h: number): boolean {
    return this.mx >= x && this.my >= y && this.mx < x + w && this.my < y + h;
  }

  endFrame(): void {
    this.pressed = false;
    this.released = false;
    this.wheel = 0;
    this.keys = [];
    this.consumed.clear();
  }
}
