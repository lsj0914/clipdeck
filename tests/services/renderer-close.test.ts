import { describe, expect, it } from "vitest";
import { RendererCloseBridge } from "../../src/main/renderer-close";

describe("main-owned close handshake", () => {
  it("accepts only the pending nonce and a bounded preparation response", async () => {
    let token = "";
    const bridge = new RendererCloseBridge((action, id) => { expect(action).toBe("apply"); token = id!; });
    const prepared = bridge.prepare("apply");
    expect(bridge.receive("unissued", { ready: true, locale: "en" })).toBe(false);
    expect(bridge.receive(token, { ready: true, locale: "en", path: "/private/file" })).toBe(false);
    expect(bridge.receive(token, { ready: false, locale: "en", error: "x".repeat(501) })).toBe(false);
    expect(bridge.receive(token, { ready: true, locale: "zh" })).toBe(true);
    expect(await prepared).toEqual({ ready: true, locale: "zh" });
    expect(bridge.receive(token, { ready: true, locale: "en" })).toBe(false);
  });
  it("missing renderer acknowledgement fails safely and restores editing", async () => {
    const sent: string[] = [];
    const bridge = new RendererCloseBridge((action) => { sent.push(action); }, 5);
    await expect(bridge.prepare("apply")).rejects.toThrow(/respond/);
    bridge.resume();
    expect(sent).toEqual(["apply", "resume"]);
  });
  it("destroyed windows reject pending preparation rather than authorize exit", async () => {
    const bridge = new RendererCloseBridge(() => {});
    const prepared = bridge.prepare("apply");
    bridge.dispose();
    await expect(prepared).rejects.toThrow(/unavailable/);
  });
});
