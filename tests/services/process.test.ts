import { it, expect } from "vitest";
import { runProcess } from "../../src/main/services/process";
it("binary native output keeps invalid UTF-8 bytes exactly and stops after a callback failure", async () => {
  const packets: Buffer[] = [];
  await runProcess(process.execPath, ["-e", "process.stdout.write(Buffer.from([0,255,128,10,192,13]))"], {
    onStdoutBytes: (packet) => packets.push(Buffer.from(packet)),
  });
  expect(Buffer.concat(packets)).toEqual(Buffer.from([0, 255, 128, 10, 192, 13]));
  let callbacks = 0;
  await expect(runProcess(process.execPath, ["-e", "setInterval(()=>process.stdout.write(Buffer.alloc(1024)),2)"], {
    onStdoutBytes: () => { callbacks++; throw new Error("Controlled binary ceiling"); },
  })).rejects.toThrow("Controlled binary ceiling");
  expect(callbacks).toBe(1);
});
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
