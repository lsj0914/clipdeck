import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, stat: vi.fn(fs.stat), statfs: vi.fn(fs.statfs) };
});
import { stat, statfs } from "node:fs/promises";
import { DiskReservations, DISK_RESERVE } from "../../src/main/services/capacity";
afterEach(() => vi.restoreAllMocks());
it("two concurrent tasks cannot each reserve the same remaining disk bytes", async () => {
  vi.mocked(stat).mockResolvedValue({ dev: 17 } as any);
  vi.mocked(statfs).mockResolvedValue({ bsize: 1, bavail: DISK_RESERVE + 200 } as any);
  const capacity = new DiskReservations();
  const results = await Promise.allSettled([capacity.reserve("/neutral-one", 150), capacity.reserve("/neutral-two", 100)]);
  expect(results[0].status).toBe("fulfilled");
  expect(results[1]).toMatchObject({ status: "rejected", reason: new Error("Not enough free space for media processing and audio verification") });
  if (results[0].status === "fulfilled") { results[0].value(); results[0].value(); }
  const release = await capacity.reserve("/neutral-retry", 200);
  release();
});
it("a different filesystem has an independent reservation and failed checks do not leak capacity", async () => {
  vi.mocked(stat).mockImplementation(async (file) => ({ dev: file === "/first" ? 1 : 2 }) as any);
  vi.mocked(statfs).mockResolvedValue({ bsize: 1, bavail: DISK_RESERVE + 200 } as any);
  const capacity = new DiskReservations();
  const first = await capacity.reserve("/first", 200);
  await expect(capacity.reserve("/second", 201)).rejects.toThrow(/free space/);
  const second = await capacity.reserve("/second", 200);
  first(); second();
});
