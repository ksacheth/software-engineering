export class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst = ratePerSecond,
  ) {
    this.tokens = burst;
  }

  tryRemove(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** How long a caller should wait before tryRemove() can succeed; 0 when it can now. */
  msUntilAvailable(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
    this.last = now;
  }
}
