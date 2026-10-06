import { it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { MediaProtocol } from "../../src/main/services/media-protocol";
let dir: string, file: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clipdeck-protocol-"));
  file = path.join(dir, "private.mp4");
  await writeFile(file, "0123456789");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
it("serves approved IDs with bounded byte ranges, suffixes and HEAD for seeking", async () => {
  const protocol = new MediaProtocol();
  const url = protocol.register(file);
  for (const [range, body, contentRange] of [
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=7-99", "789", "bytes 7-9/10"],
  ]) {
    const response = await protocol.handle(
      new Request(url, { headers: { Range: range! } }),
      true,
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("content-range")).toBe(contentRange);
  }
  const head = await protocol.handle(
    new Request(url, { method: "HEAD" }),
    true,
  );
  expect(head.headers.get("content-length")).toBe("10");
  expect(await head.text()).toBe("");
});
it("denies foreign callers, forged IDs, hosts, encoded traversal, query paths and malformed ranges", async () => {
  const p = new MediaProtocol();
  const url = p.register(file);
  expect((await p.handle(new Request(url), false)).status).toBe(403);
  for (const forged of [
    "clipdeck-media://media/00000000-0000-0000-0000-000000000000",
    url.replace("//media/", "//attacker/"),
    url + "?path=/etc/passwd",
    url + "/../%2fetc%2fpasswd",
  ])
    expect((await p.handle(new Request(forged), true)).status).toBe(403);
  for (const range of [
    "bytes=1-2,4-5",
    "bytes=100-",
    "bytes=-0",
    "bytes=7-2",
    "bytes=a-b",
    "bytes=999999999999999999999999-",
  ])
    expect(
      (await p.handle(new Request(url, { headers: { Range: range } }), true))
        .status,
    ).toBe(416);
  expect(p.accepts(url.replace("//media/", "//user@media/"))).toBe(false);
  p.revoke(url);
  expect((await p.handle(new Request(url), true)).status).toBe(403);
});
it("rejects stale authorization and changed backing files", async () => {
  const p = new MediaProtocol();
  const denied = p.register(file, async () => false);
  expect((await p.handle(new Request(denied), true)).status).toBe(410);
  const own = path.join(dir, "own.mp4");
  await writeFile(own, "original");
  const url = p.register(own);
  await writeFile(own, "replacement");
  expect((await p.handle(new Request(url), true)).status).toBe(410);
});
