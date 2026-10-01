/** When the last frame was drawn. WebKit throttles hidden windows; logic must not depend on frames then. */
export const frameClock = { last: 0 };

/** True when frames have stopped or slowed to a crawl (window hidden, covered or minimised). */
export function framesStarved(): boolean {
  return performance.now() - frameClock.last > 400;
}
