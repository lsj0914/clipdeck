import type {
  AssemblyPlan,
  Project,
  AssemblySegment,
  Transcript,
} from "../shared/contracts";
import { reconcileCut } from "./project";
import { interval, integer } from "./validation";
export function buildAssemblyPlan(project: Project): AssemblyPlan {
  if (!project.cutOrder.length)
    throw new Error("Add at least one cut before preparing an assembly");
  const wordIdsCache = new Map<Transcript, Set<string>>();
  let frames = 0,
    samples = 0;
  const segments: AssemblySegment[] = project.cutOrder.map((cutId) => {
    const c = project.cuts.find((c) => c.id === cutId);
    if (!c) throw new Error("Unknown cut");
    if (
      reconcileCut(c, project.assets, project.transcripts, wordIdsCache)
        .needsReview
    )
      throw new Error("Transcript or source requires cut review");
    const asset = project.assets.find((a) => a.id === c.assetId);
    if (
      !asset ||
      asset.status !== "ready" ||
      c.needsReview ||
      c.fingerprint !== asset.fingerprint
    )
      throw new Error("Source requires relinking or cut review");
    interval(c.startMs, c.endMs, asset.durationMs);
    const frameCount = Math.max(
      1,
      Math.ceil(((c.endMs - c.startMs) * 30) / 1000),
    );
    const sampleCount = frameCount * 1600;
    integer(frames + frameCount);
    integer(samples + sampleCount);
    const segment = {
      cutId,
      assetId: c.assetId,
      fingerprint: c.fingerprint,
      startMs: c.startMs,
      endMs: c.endMs,
      frameCount,
      sampleCount,
      startFrame: frames,
      endFrame: frames + frameCount,
      startSample: samples,
      endSample: samples + sampleCount,
    };
    frames += frameCount;
    samples += sampleCount;
    return segment;
  });
  return {
    projectId: project.id,
    revision: project.revision,
    output: { ...project.output },
    segments,
    totalFrames: frames,
    totalSamples: samples,
    durationMs: (frames * 1000) / 30,
  };
}
