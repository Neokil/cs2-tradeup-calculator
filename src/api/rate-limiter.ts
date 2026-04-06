export class RateLimiter {
  private lastRequest = 0;

  constructor(private minIntervalMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.minIntervalMs) {
      await new Promise(resolve => setTimeout(resolve, this.minIntervalMs - elapsed));
    }
    this.lastRequest = Date.now();
  }
}
