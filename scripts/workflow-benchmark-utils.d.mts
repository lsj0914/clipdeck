export interface BenchmarkSource {
  id: string; path: string; file: string; sha256: string;
  duration_seconds?: number; pcm_duration_seconds?: number;
  audio_kind?: string; visual_kind?: string;
}
export interface BenchmarkPassage {
  id: string; source_id: string; start_seconds: number; end_seconds: number;
  startMs: number; endMs: number; expected_text?: string;
}
export function loadBenchmarkInputs(directory: string): Promise<{ sources: BenchmarkSource[]; passages: BenchmarkPassage[]; manifest: any; manifestSha256: string }>;
export function parsePcmWav(bytes: Buffer): { channels: number; sampleRate: number; bytesPerSample: number; samples: number; durationSeconds: number; data: Buffer };
export function processTreeSample(stdout: string, rootPid: number): { treeRssKiB: number; nativeRssKiB: number; processes: Array<{ pid: number; ppid: number; rssKiB: number; command: string }> };
export function publicReceipt<T>(value: T, roots?: Record<string, string>): T;
export function requireBenchmarkNodeVersion(version: string): void;
export function summarizeRendererEvidence(report: any, actions: any[], actionsSha256: string): {
  sourceCommit: string; maximumMs: number; withinInteractionThreshold: boolean;
  operationP95Ms: Record<string, number>; measuredSamples: any[]; unmeasuredSetupRows: number;
  [key: string]: any;
};
