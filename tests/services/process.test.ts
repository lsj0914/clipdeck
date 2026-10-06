import { it, expect } from "vitest";
import { runProcess } from "../../src/main/services/process";
it("preserves Unicode JSONL text across native byte chunk boundaries", async () => {
  const result = await runProcess(process.execPath, [
    "-e",
    "const b=Buffer.from('中文');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),30)",
  ]);
  expect(result.stdout).toBe("中文");
});
it("native cancellation resolves only after the child is gone", async () => {
  const controller = new AbortController();
  let pid = 0;
  const done = runProcess(
    process.execPath,
    ["-e", "console.log(process.pid);setInterval(()=>{},100)"],
    {
      signal: controller.signal,
      onStdout: (s) => {
        pid = Number(s.trim());
        controller.abort();
      },
    },
  );
  await expect(done).rejects.toThrow(/cancel/i);
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
});
