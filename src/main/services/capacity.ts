import { stat, statfs } from "node:fs/promises";
export const DISK_RESERVE = 256 * 1024 ** 2;
export const DISK_CAPACITY_ERROR = "Not enough free space for media processing and audio verification";
/** Reservations share a filesystem identity across ASR, previews and exports.
 * They prevent two queued tasks from each claiming the same remaining bytes. */
export class DiskReservations {
  private reserved = new Map<number, number>();
  private queue: Promise<unknown> = Promise.resolve();
  reserve(parent: string, bytes: number): Promise<() => void> {
    const next = this.queue.catch(() => {}).then(async () => {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid media storage estimate");
      const [location, free] = await Promise.all([stat(parent), statfs(parent)]);
      const already = this.reserved.get(location.dev) ?? 0;
      if (free.bavail * free.bsize < already + bytes + DISK_RESERVE)
        throw new Error(DISK_CAPACITY_ERROR);
      this.reserved.set(location.dev, already + bytes);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (this.reserved.get(location.dev) ?? 0) - bytes;
        if (remaining > 0) this.reserved.set(location.dev, remaining);
        else this.reserved.delete(location.dev);
      };
    });
    this.queue = next;
    return next;
  }
}
export const mediaDiskReservations = new DiskReservations();
