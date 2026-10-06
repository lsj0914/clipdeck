/** Serializable boundaries. Native paths are owned by main and never appear in snapshots. */
export type ModelChoice = "small" | "turbo";
export interface TranscriptionOptions {
  vocabulary?: string;
}
export type Language = "auto" | "en" | "zh";
export type Fingerprint = string;
export interface Asset {
  id: string;
  name: string;
  fileRef: string;
  status: "ready" | "missing" | "changed";
  fingerprint: Fingerprint;
  durationMs: number;
  width: number;
  height: number;
  rotation: number;
  fps: number;
  sampleAspectRatio?: number;
  hasAudio: boolean;
}
export interface TimedWord {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  timingNeedsReview?: boolean;
}
export interface TranscriptSegment {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  wordIds: string[];
}
export interface Transcript {
  assetId: string;
  fingerprint: Fingerprint;
  revision: number;
  language: Language;
  segments: TranscriptSegment[];
  words: TimedWord[];
  model: { id: string; digest: string };
  engine: { name: string; version: string };
  originId?: string;
  parameters: {
    vad: boolean;
    vocabulary?: string;
    simplifiedChinese?: boolean;
    conditionOnPreviousText?: boolean;
    // Absent on legacy transcripts whose word-timing review provenance is unknown.
    wordTimingReview?: boolean;
    punctuation?: { id: string; revision: string; sha256: string };
  };
}
export interface Cut {
  id: string;
  assetId: string;
  fingerprint: Fingerprint;
  transcriptRevision: number | null;
  startMs: number;
  endMs: number;
  wordIds: string[];
  text: string;
  note: string;
  needsReview: boolean;
  textSource?: "derived" | "custom";
}
export type OutputPreset = "landscape" | "portrait" | "square";
export interface OutputSettings {
  preset: OutputPreset;
  width: number;
  height: number;
  fps: 30;
  sampleRate: 48000;
}
export interface ProjectData {
  formatVersion: 1;
  id: string;
  revision: number;
  name: string;
  assets: Asset[];
  transcripts: Transcript[];
  cuts: Cut[];
  cutOrder: string[];
  output: OutputSettings;
  savedAt: string | null;
}
/** History stays in memory; ProjectData is the persisted format. */
export type EditableState = Pick<
  ProjectData,
  "name" | "cuts" | "cutOrder" | "output" | "transcripts"
>;
export interface Project extends ProjectData {
  history: { past: EditableState[]; future: EditableState[] };
}
export type EditCommand =
  | {
      type: "correctTranscript";
      assetId: string;
      fingerprint: string;
      transcriptRevision: number;
      changes: Array<{ wordId: string; text: string }>;
    }
  | { type: "addCut"; cut: Cut }
  | {
      type: "updateCut";
      cutId: string;
      changes: Partial<Pick<Cut, "startMs" | "endMs" | "text" | "note">>;
    }
  | { type: "removeCut"; cutId: string }
  | { type: "reorderCuts"; cutIds: string[] }
  | { type: "setOutput"; preset: OutputPreset }
  | { type: "renameProject"; name: string }
  | { type: "undo" }
  | { type: "redo" };
export interface AssemblySegment {
  cutId: string;
  assetId: string;
  fingerprint: Fingerprint;
  startMs: number;
  endMs: number;
  frameCount: number;
  sampleCount: number;
  startFrame: number;
  endFrame: number;
  startSample: number;
  endSample: number;
}
export interface AssemblyPlan {
  projectId: string;
  revision: number;
  output: OutputSettings;
  segments: AssemblySegment[];
  totalFrames: number;
  totalSamples: number;
  durationMs: number;
}
export type JobKind =
  "transcription" | "preview" | "export" | "modelDownload" | "sourcePreview";
export type JobStatus =
  "queued" | "running" | "cancelling" | "cancelled" | "failed" | "completed";
export interface Job {
  id: string;
  projectId?: string;
  projectRevision?: number;
  kind: JobKind;
  status: JobStatus;
  stage: string;
  processedMs: number;
  totalMs: number | null;
  progress: number | null;
  error: string | null;
  cancelRequested: boolean;
  assetId: string | null;
  outputUrl: string | null;
}
export interface ModelStatus {
  choice?: ModelChoice;
  available?: Array<{ choice: ModelChoice; label: string; bytes: number }>;
  status: "notReady" | "ready" | "downloading" | "failed";
  id: string | null;
  message: string;
  progress: number | null;
}
export type SafeAsset = Omit<Asset, "fileRef"> & { mediaUrl: string | null };
export interface TranscriptionDraft {
  assetId: string;
  language: Language;
  words: TimedWord[];
  segments: TranscriptSegment[];
}
export interface WorkspaceSnapshot {
  importFailures?: Array<{ name: string; message: string }>;
  transcriptionDrafts?: Record<string, TranscriptionDraft>;
  project: Omit<ProjectData, "assets"> & { assets: SafeAsset[] };
  model: ModelStatus;
  jobs: Job[];
  save: {
    dirty: boolean;
    displayName: string | null;
    recovered: boolean;
    error?: string | null;
  };
  canUndo: boolean;
  canRedo: boolean;
  capabilities: {
    media: boolean;
    transcription: boolean;
    rendering: boolean;
    persistence: boolean;
  };
}
export interface ClipDeckAPI {
  getSnapshot(): Promise<WorkspaceSnapshot>;
  importMedia(): Promise<WorkspaceSnapshot>;
  importDroppedFiles(files: File[]): Promise<WorkspaceSnapshot>;
  applyEdit(command: EditCommand): Promise<WorkspaceSnapshot>;
  transcribe(
    assetId: string,
    language: Language,
    options?: TranscriptionOptions,
  ): Promise<string>;
  prepareSourcePreview(assetId: string): Promise<string>;
  preparePreview(): Promise<string>;
  exportVideo(): Promise<string>;
  cancelJob(jobId: string): Promise<void>;
  openProject(): Promise<WorkspaceSnapshot>;
  saveProject(asNew?: boolean): Promise<WorkspaceSnapshot>;
  relinkMedia(assetId: string): Promise<WorkspaceSnapshot>;
  chooseModel(): Promise<WorkspaceSnapshot>;
  downloadModel(choice?: ModelChoice): Promise<string>;
  revealExport(jobId: string): Promise<void>;
  subscribe(listener: (snapshot: WorkspaceSnapshot) => void): () => void;
}
export type IpcMethod = Exclude<keyof ClipDeckAPI, "subscribe">;
export interface IpcRequest {
  method: IpcMethod;
  args: unknown[];
}
export interface ServiceError {
  code: "INVALID_INPUT" | "UNAUTHORIZED" | "NOT_READY" | "FAILED";
  message: string;
}
export type IpcResponse =
  { ok: true; value: unknown } | { ok: false; error: ServiceError };
export const IPC_REQUEST = "clipdeck:request";
export const IPC_SNAPSHOT = "clipdeck:snapshot";
declare global {
  interface Window {
    clipdeck: ClipDeckAPI;
  }
}
