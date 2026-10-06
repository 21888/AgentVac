import type { AppContext, Batch, TrashConfirmation } from "../shared/types.js";
/** Renderer convenience state only. The engine owns every real consent check. */
export class TrashConsent {
  challenge: TrashConfirmation | null = null;
  impact = false;
  confirmedClosed = false;
  phrase = "";
  private revision = 0;
  reset(): string | undefined {
    const token = this.challenge?.token;
    this.challenge = null;
    this.impact = false;
    this.confirmedClosed = false;
    this.phrase = "";
    this.revision++;
    return token;
  }
  generation() {
    return this.revision;
  }
  accept(
    generation: number,
    value: TrashConfirmation,
    batch: Batch,
    context: AppContext,
  ): boolean {
    if (
      generation !== this.revision ||
      !this.matches(value, batch, context, Date.now())
    )
      return false;
    this.challenge = value;
    return true;
  }
  private matches(
    value: TrashConfirmation | null,
    batch: Batch | null,
    context: AppContext,
    now: number,
  ) {
    return (
      !!value &&
      !!batch &&
      typeof value.token === "string" &&
      value.token.length > 0 &&
      value.batchId === batch.id &&
      value.root === batch.root &&
      value.root === context.root &&
      value.provider === (batch.provider ?? "codex") &&
      value.provider === (context.provider ?? "codex") &&
      value.demo === context.demo &&
      Number.isFinite(value.expiresAt) &&
      now < value.expiresAt
    );
  }
  ready(
    batch: Batch | null,
    context: AppContext,
    busy: boolean,
    canSign: boolean,
    now: number,
  ): boolean {
    return (
      !busy &&
      canSign &&
      this.impact === true &&
      this.confirmedClosed === true &&
      this.phrase.trim() === "回收站" &&
      this.matches(this.challenge, batch, context, now)
    );
  }
  consume(
    batch: Batch | null,
    context: AppContext,
    busy: boolean,
    canSign: boolean,
    now: number,
  ): [string, true, true, string] | undefined {
    if (!this.ready(batch, context, busy, canSign, now)) return;
    const args: [string, true, true, string] = [
      batch!.id,
      true,
      true,
      this.challenge!.token,
    ];
    this.reset();
    return args;
  }
}
