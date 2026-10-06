import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  ClipDeckAPI,
  SafeAsset,
  WorkspaceSnapshot,
} from "../shared/contracts";
import { message } from "./format";

type Attempt = {
  pending: boolean;
  jobId?: string;
  seenJobId?: string;
  error?: string;
};
const working = (status: string) =>
  ["queued", "running", "cancelling"].includes(status);

/** Native jobs own conversion; this ledger only prevents repeated UI requests. */
export function useSourcePreview(
  api: ClipDeckAPI,
  snapshot: WorkspaceSnapshot | null,
  asset: SafeAsset | undefined,
) {
  const key = JSON.stringify([
    snapshot?.project.id,
    asset?.id,
    asset?.fingerprint,
  ]);
  const attempts = useRef(new Map<string, Attempt>());
  const fallbackAttempts = useRef(new Set<string>());
  const urls = useRef(new Map<string, string>());
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const currentSnapshot = useRef(snapshot);
  currentSnapshot.current = snapshot;
  const currentKey = useRef(key);
  currentKey.current = key;
  const available = !!snapshot?.capabilities.rendering;
  const job = snapshot?.jobs.findLast(
    (j) =>
      j.kind === "sourcePreview" &&
      j.assetId === asset?.id &&
      (!j.projectId || j.projectId === snapshot.project.id),
  );
  const request = useCallback(
    async (assetId = asset?.id) => {
      const latest = currentSnapshot.current;
      const target = latest?.project.assets.find((a) => a.id === assetId);
      if (
        !target ||
        target.status !== "ready" ||
        !latest?.capabilities.rendering
      )
        return;
      const requestKey = JSON.stringify([
        latest.project.id,
        target.id,
        target.fingerprint,
      ]);
      const previous = attempts.current.get(requestKey);
      const published =
        previous?.jobId &&
        latest.jobs.find(
          (j) =>
            j.id === previous.jobId &&
            j.kind === "sourcePreview" &&
            j.assetId === target.id &&
            (!j.projectId || j.projectId === latest.project.id),
        );
      if (previous && published) {
        previous.pending = false;
        previous.seenJobId = published.id;
      }
      if (
        previous?.pending ||
        latest.jobs.some(
          (j) =>
            j.kind === "sourcePreview" &&
            j.assetId === target.id &&
            (!j.projectId || j.projectId === latest.project.id) &&
            working(j.status),
        )
      )
        return;
      const attempt: Attempt = { pending: true };
      attempts.current.set(requestKey, attempt);
      refresh();
      try {
        attempt.jobId = await api.prepareSourcePreview(target.id);
      } catch (error) {
        attempt.pending = false;
        attempt.error = message(error);
      }
      if (currentKey.current === requestKey) refresh();
    },
    [api, asset?.id],
  );
  const requestJobId = attempts.current.get(key)?.jobId;
  useEffect(() => {
    if (!asset) return;
    if (asset.status !== "ready") {
      attempts.current.delete(key);
      urls.current.delete(key);
      fallbackAttempts.current.delete(key);
      return;
    }
    if (asset.mediaUrl) {
      urls.current.set(key, asset.mediaUrl);
      return;
    }
    if (urls.current.delete(key) && !attempts.current.get(key)?.pending)
      attempts.current.delete(key);
    let attempt = attempts.current.get(key);
    const seenJobId = attempt?.seenJobId;
    if (seenJobId && !snapshot?.jobs.some((j) => j.id === seenJobId)) {
      attempts.current.delete(key);
      attempt = undefined;
    }
    if (attempt?.jobId && job?.id === attempt.jobId) {
      attempt.seenJobId = job.id;
      attempt.pending = false;
      refresh();
    }
    if (!attempt && job) {
      attempts.current.set(key, {
        pending: false,
        jobId: job.id,
        seenJobId: job.id,
      });
      refresh();
    } else if (!attempt && available) void request();
  }, [
    key,
    asset?.status,
    asset?.mediaUrl,
    job,
    snapshot?.jobs,
    available,
    request,
    requestJobId,
  ]);
  const attempt = attempts.current.get(key);
  const visibleJob =
    attempt?.pending && attempt.jobId !== job?.id ? undefined : job;
  return {
    key,
    available,
    job: visibleJob,
    pending: !!attempt?.pending || (!!visibleJob && working(visibleJob.status)),
    error:
      attempt?.error ??
      (visibleJob?.status === "failed"
        ? (visibleJob.error ?? "Source preview could not be prepared.")
        : null),
    request,
    fallback: () => {
      if (
        !asset?.mediaUrl ||
        !available ||
        fallbackAttempts.current.has(key) ||
        attempts.current.has(key) ||
        job
      )
        return false;
      fallbackAttempts.current.add(key);
      void request();
      return true;
    },
    reset: () => {
      attempts.current.clear();
      fallbackAttempts.current.clear();
      urls.current.clear();
      refresh();
    },
  };
}
