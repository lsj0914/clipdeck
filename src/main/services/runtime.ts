import path from "node:path";
export interface RuntimePaths {
  ffmpeg: string;
  ffprobe: string;
  python: string;
  worker: string;
}
/** Packaged resources only, or a project-local development runtime. No PATH/cache fallback. */
export function resolveRuntime(options: {
  appRoot: string;
  resourcesRoot: string;
  packaged: boolean;
}): RuntimePaths {
  const runtime = options.packaged
    ? path.join(options.resourcesRoot, "runtime")
    : path.join(options.appRoot, ".runtime");
  return {
    ffmpeg: path.join(runtime, "bin/ffmpeg"),
    ffprobe: path.join(runtime, "bin/ffprobe"),
    python: path.join(runtime, "worker/bin/python3.12"),
    worker: path.join(
      options.packaged ? options.resourcesRoot : options.appRoot,
      "worker/transcribe.py",
    ),
  };
}
