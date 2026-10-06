import type { ClosePreparation } from "../../shared/contracts";

export interface CloseHooks {
  prepare(mode: "apply" | "discard"): Promise<ClosePreparation>;
  confirmDiscard(error: string): Promise<boolean>;
  hasRunningJobs(): boolean;
  confirmCancelJobs(): Promise<boolean>;
  cancelJobs(): Promise<void>;
  hasUnsavedChanges(): boolean;
  chooseSave(): Promise<"save" | "recovery" | "cancel">;
  save(): Promise<boolean>;
  preserveRecovery(): Promise<void>;
  reportFailure(error: unknown): Promise<void>;
  resume(): void;
}
export class CloseCoordinator {
  private pending: Promise<boolean> | null = null;
  constructor(readonly hooks: CloseHooks) {}
  request(): Promise<boolean> {
    if (!this.pending)
      this.pending = this.attempt().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async attempt(): Promise<boolean> {
    let accepted = false;
    const h = this.hooks;
    try {
      const prepared = await h.prepare("apply");
      if (!prepared.ready) {
        if (!prepared.canDiscard) throw new Error(prepared.error ?? "The editor is not ready to close.");
        if (!await h.confirmDiscard(prepared.error ?? "Unapplied edits need attention.")) return false;
        const discarded = await h.prepare("discard");
        if (!discarded.ready) throw new Error(discarded.error ?? "Could not discard unapplied edits.");
      }
      if (h.hasRunningJobs()) {
        if (!await h.confirmCancelJobs()) return false;
        await h.cancelJobs();
      }
      if (h.hasUnsavedChanges()) {
        const choice = await h.chooseSave();
        if (choice === "cancel") return false;
        if (choice === "save" && !await h.save()) return false;
      }
      // Completion is the durable recovery boundary, never a finally callback.
      await h.preserveRecovery();
      accepted = true;
      return true;
    } catch (error) {
      await h.reportFailure(error);
      return false;
    } finally {
      if (!accepted) h.resume();
    }
  }
}
