import { randomUUID } from "node:crypto";
import { constants, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
export const MEDIA_SCHEME = "clipdeck-media";
interface Entry {
  path: string;
  signature: string;
  valid: (signal: AbortSignal) => Promise<boolean>;
}
export function fileSignature(file: string): string {
  const s = statSync(file);
  return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
}
/** Random, main-issued capabilities. No URL component is ever interpreted as a path. */
export class MediaProtocol {
  private entries = new Map<string, Entry>();
  lastServedUrl: string | null = null;
  register(file: string, valid: Entry["valid"] = async () => true): string {
    const id = randomUUID();
    this.entries.set(id, { path: file, signature: fileSignature(file), valid });
    return `${MEDIA_SCHEME}://media/${id}`;
  }
  revoke(url: string): void {
    const id = this.token(url);
    if (id) this.entries.delete(id);
  }
  private token(url: string): string | null {
    return /^clipdeck-media:\/\/media\/([a-f0-9-]{36})$/.exec(url)?.[1] ?? null;
  }
  accepts(url: string): boolean {
    const id = this.token(url);
    return !!id && this.entries.has(id);
  }
  available(url: string): boolean {
    const id = this.token(url),
      entry = id ? this.entries.get(id) : undefined;
    try {
      return !!entry && fileSignature(entry.path) === entry.signature;
    } catch {
      return false;
    }
  }
  async handle(request: Request, authorized: boolean): Promise<Response> {
    const id = this.token(request.url),
      entry = id ? this.entries.get(id) : undefined;
    if (!authorized || !entry) return new Response(null, { status: 403 });
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405 });
    let file;
    try {
      if (
        !(await entry.valid(request.signal)) ||
        fileSignature(entry.path) !== entry.signature
      )
        return new Response(null, { status: 410 });
      file = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const s = await file.stat();
      if (
        !s.isFile() ||
        [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":") !==
          entry.signature
      ) {
        await file.close();
        return new Response(null, { status: 410 });
      }
      const size = s.size,
        range = request.headers.get("range");
      let start = 0,
        end = size - 1;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
          await file.close();
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${size}` },
          });
        }
        if (!match[1]) start = Math.max(0, size - Number(match[2]));
        else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= size
        ) {
          await file.close();
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${size}` },
          });
        }
      }
      const headers: Record<string, string> = {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };
      if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      if (request.method === "HEAD") {
        await file.close();
        return new Response(null, { status: range ? 206 : 200, headers });
      }
      this.lastServedUrl = request.url;
      const stream = file.createReadStream({ start, end, autoClose: true });
      const abort = () => stream.destroy();
      request.signal.addEventListener("abort", abort, { once: true });
      stream.once("close", () =>
        request.signal.removeEventListener("abort", abort),
      );
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: range ? 206 : 200,
        headers,
      });
    } catch {
      await file?.close().catch(() => {});
      return new Response(null, { status: 410 });
    }
  }
}
