import { describe, expect, it } from "vitest";
import { CloseCoordinator, type CloseHooks } from "../../src/main/services/close";

function fixture(overrides: Partial<CloseHooks> = {}) {
  const events: string[] = [];
  const hooks: CloseHooks = {
    prepare: async (mode) => { events.push(mode); return { ready: true, locale: "en" }; },
    confirmDiscard: async () => false,
    hasRunningJobs: () => false,
    confirmCancelJobs: async () => false,
    cancelJobs: async () => { events.push("cancel-jobs"); },
    hasUnsavedChanges: () => true,
    chooseSave: async () => "recovery",
    save: async () => { events.push("save"); return true; },
    preserveRecovery: async () => { events.push("recovery"); },
    reportFailure: async () => { events.push("error"); },
    resume: () => { events.push("resume"); },
    ...overrides,
  };
  return { events, hooks, close: new CloseCoordinator(hooks) };
}

describe("safe desktop close", () => {
  it("keeps the renderer alive on failed recovery and allows a repaired retry", async () => {
    let attempts = 0;
    const f = fixture({ preserveRecovery: async () => {
      if (++attempts === 1) throw new Error("disk unavailable");
    } });
    expect(await f.close.request()).toBe(false);
    expect(f.events).toEqual(["apply", "error", "resume"]);
    expect(await f.close.request()).toBe(true);
    expect(attempts).toBe(2);
  });
  it("flushes valid drafts before preserving recovery", async () => {
    const f = fixture();
    expect(await f.close.request()).toBe(true);
    expect(f.events).toEqual(["apply", "recovery"]);
  });
  it("keeps invalid drafts unless the user explicitly discards them", async () => {
    let discard = false;
    const f = fixture({
      prepare: async (mode) => {
        f.events.push(mode);
        return mode === "apply"
          ? { ready: false, canDiscard: true, locale: "en", error: "invalid cut" }
          : { ready: true, locale: "en" };
      },
      confirmDiscard: async () => discard,
    });
    expect(await f.close.request()).toBe(false);
    expect(f.events).toEqual(["apply", "resume"]);
    discard = true;
    expect(await f.close.request()).toBe(true);
    expect(f.events.slice(2)).toEqual(["apply", "discard", "recovery"]);
  });
  it("does not offer draft discard when another operation is still active", async () => {
    const f = fixture({ prepare: async () => ({ ready: false, locale: "en", error: "busy" }),
      confirmDiscard: async () => { throw new Error("must not offer discard"); } });
    expect(await f.close.request()).toBe(false);
    expect(f.events).toEqual(["error", "resume"]);
  });
  it("does not cancel running tasks when the user keeps working", async () => {
    const f = fixture({ hasRunningJobs: () => true });
    expect(await f.close.request()).toBe(false);
    expect(f.events).toEqual(["apply", "resume"]);
  });
  it("waits for confirmed task cancellation before saving", async () => {
    const f = fixture({ hasRunningJobs: () => true, confirmCancelJobs: async () => true,
      chooseSave: async () => "save" });
    expect(await f.close.request()).toBe(true);
    expect(f.events).toEqual(["apply", "cancel-jobs", "save", "recovery"]);
  });
  it("cancelled native Save As cannot commit exit", async () => {
    const f = fixture({ chooseSave: async () => "save", save: async () => false });
    expect(await f.close.request()).toBe(false);
    expect(f.events).toEqual(["apply", "resume"]);
  });
  it("cancelled unsaved-changes prompt leaves the workspace available", async () => {
    const f = fixture({ chooseSave: async () => "cancel" });
    expect(await f.close.request()).toBe(false);
    expect(f.events).toEqual(["apply", "resume"]);
  });
  it("coalesces repeated native close and quit requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fixture({ preserveRecovery: async () => { f.events.push("recovery"); await gate; } });
    const one = f.close.request(), two = f.close.request();
    expect(one).toBe(two);
    release();
    expect(await one).toBe(true);
    expect(f.events).toEqual(["apply", "recovery"]);
  });
});
