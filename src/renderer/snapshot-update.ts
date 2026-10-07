import type { TranscriptBasis, WorkspaceSnapshot, WorkspaceUpdate } from "../shared/contracts";

export class MissingTranscriptReferenceError extends Error {
  constructor() { super("Transcript reference is unavailable; read a complete workspace snapshot."); }
}

export function snapshotBasis(snapshot: WorkspaceSnapshot | null): TranscriptBasis | null {
  return snapshot ? {
    projectId: snapshot.project.id,
    versions: Object.entries(snapshot.transcriptVersions ?? {}).map(([assetId, version]) => ({ assetId, version })),
  } : null;
}
export function hydrateSnapshot(update: WorkspaceUpdate, previous: WorkspaceSnapshot | null): WorkspaceSnapshot {
  if (!update.project.transcripts.some(transcript => "referenceVersion" in transcript))
    return update as WorkspaceSnapshot;
  const cached = new Map(previous?.project.transcripts.map(transcript => [transcript.assetId, transcript]));
  const transcripts = update.project.transcripts.map(transcript => {
    if (!("referenceVersion" in transcript)) return transcript;
    const version = transcript.referenceVersion, prior = cached.get(transcript.assetId);
    if (!prior || previous?.project.id !== update.project.id ||
        previous.transcriptVersions?.[transcript.assetId] !== version ||
        update.transcriptVersions?.[transcript.assetId] !== version)
      throw new MissingTranscriptReferenceError();
    return prior;
  });
  return { ...update, project: { ...update.project, transcripts } };
}
