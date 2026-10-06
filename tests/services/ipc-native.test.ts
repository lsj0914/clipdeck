import { it, expect } from "vitest";
import { realpath } from "node:fs/promises";
import { createDispatcher, safeSnapshot } from "../../src/main/ipc";
it("native filesystem errors retain an actionable failure without exposing host paths", async () => {
  const privatePath =
    "/private/tmp/clipdeck-private-source-does-not-exist-2026-10-06";
  const dispatch = createDispatcher({
    getSnapshot: async () => {
      await realpath(privatePath);
      return safeSnapshot();
    },
  });
  const response = await dispatch({ method: "getSnapshot", args: [] }, true);
  expect(response.ok).toBe(false);
  expect(JSON.stringify(response)).not.toContain(privatePath);
  if (!response.ok)
    expect(response.error.message).toMatch(/local|file|resource/i);
});
