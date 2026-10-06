import { randomUUID } from "node:crypto";
import type { CloseAction, ClosePreparation } from "../shared/contracts";
import { bool, oneOf, record, text } from "../domain/validation";

/** A main-issued nonce can acknowledge one close request, never other services. */
export class RendererCloseBridge {
  private pending = new Map<string, { resolve: (result: ClosePreparation) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(readonly send: (action: CloseAction, token: string | null) => void, readonly timeoutMs = 30000) {}
  prepare(action: "apply" | "discard"): Promise<ClosePreparation> {
    const token = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        reject(new Error("The editor did not respond. Keep the window open and try closing again."));
      }, this.timeoutMs);
      this.pending.set(token, { resolve, reject, timer });
      try { this.send(action, token); }
      catch (error) { clearTimeout(timer); this.pending.delete(token); reject(error); }
    });
  }
  receive(token: unknown, input: unknown): boolean {
    if (typeof token !== "string") return false;
    const waiting = this.pending.get(token);
    if (!waiting) return false;
    let result: ClosePreparation;
    try {
      const v = record(input, ["ready", "locale", "canDiscard", "error"]);
      result = { ready: bool(v.ready), locale: oneOf(v.locale, ["en", "zh"]) };
      if (v.canDiscard !== undefined) result.canDiscard = bool(v.canDiscard);
      if (v.error !== undefined) result.error = text(v.error, 500);
    } catch { return false; }
    clearTimeout(waiting.timer);
    this.pending.delete(token);
    waiting.resolve(result);
    return true;
  }
  resume(): void { this.send("resume", null); }
  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The editor is unavailable. Changes could not be prepared for closing."));
    }
    this.pending.clear();
  }
}
