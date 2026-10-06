import { it, expect } from "vitest";
import {
  parseIpcRequest,
  createDispatcher,
  safeSnapshot,
} from "../../src/main/ipc";
it("rejects arbitrary methods, paths, malformed args and object pollution", () => {
  for (const request of [
    null,
    { method: "exec", args: ["rm"] },
    { method: "transcribe", args: ["a", "fr"] },
    { method: "getSnapshot", args: ["/etc/passwd"] },
    { method: "saveProject", args: ["yes"] },
    { method: "applyEdit", args: [{ type: "undo", path: "/etc/passwd" }] },
    { method: "getSnapshot", args: [], constructor: "polluted" },
  ])
    expect(() => parseIpcRequest(request)).toThrow();
});
it("rejects a request from another document before reaching any service", async () => {
  const dispatch = createDispatcher({
    getSnapshot: () => {
      throw new Error("Service must not run");
    },
  });
  expect(
    await dispatch({ method: "getSnapshot", args: [] }, false),
  ).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
});
it("validates before dispatch and explicitly reports unsupported services", async () => {
  const dispatch = createDispatcher();
  expect(
    await dispatch({ method: "transcribe", args: ["a", "en"] }, true),
  ).toMatchObject({ ok: false, error: { code: "NOT_READY" } });
  expect(await dispatch({ method: "exec", args: [] }, true)).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it("returns an honest empty snapshot with no host paths or fake jobs", () => {
  const snapshot = safeSnapshot(undefined);
  expect(snapshot.project.assets).toEqual([]);
  expect(snapshot.jobs).toEqual([]);
  expect(snapshot.model.status).toBe("notReady");
  expect(snapshot.capabilities.media).toBe(false);
  expect(JSON.stringify(snapshot)).not.toContain("fileRef");
});

it("accepts only bounded known model choices and vocabulary options through existing bridge methods", () => {
  expect(
    parseIpcRequest({ method: "downloadModel", args: ["turbo"] }).args,
  ).toEqual(["turbo"]);
  expect(
    parseIpcRequest({
      method: "transcribe",
      args: ["a", "zh", { vocabulary: "跑步，健康" }],
    }).args,
  ).toEqual(["a", "zh", { vocabulary: "跑步，健康" }]);
  for (const args of [
    ["large"],
    [{ url: "https://example.com/model" }],
    ["/tmp/model"],
  ])
    expect(() => parseIpcRequest({ method: "downloadModel", args })).toThrow();
  for (const options of [
    { vocabulary: "a".repeat(1001) },
    { vocabulary: Array(66).fill("word").join(",") },
    { vocabulary: "fine", modelDirectory: "/tmp/private" },
    { initial_prompt: "arbitrary" },
  ])
    expect(() =>
      parseIpcRequest({ method: "transcribe", args: ["a", "zh", options] }),
    ).toThrow();
});
