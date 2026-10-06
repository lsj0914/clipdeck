import { parseTranscriptionOptions } from "../domain/transcription-options";
import { publicErrorMessage } from "./errors";
import type {
  IpcRequest,
  IpcResponse,
  WorkspaceSnapshot,
  ClipDeckAPI,
  Project,
} from "../shared/contracts";
import { createProject, parseEditCommand } from "../domain/project";
import { record, id, oneOf, bool, list, text } from "../domain/validation";
export type NativeAPI = Omit<
  ClipDeckAPI,
  "subscribe" | "importDroppedFiles"
> & { importDroppedFiles(paths: string[]): Promise<WorkspaceSnapshot> };
export type IpcServices = Partial<NativeAPI>;
const METHODS = [
  "getSnapshot",
  "importMedia",
  "importDroppedFiles",
  "applyEdit",
  "transcribe",
  "prepareSourcePreview",
  "preparePreview",
  "exportVideo",
  "cancelJob",
  "openProject",
  "saveProject",
  "relinkMedia",
  "chooseModel",
  "downloadModel",
  "revealExport",
] as const;
export function parseIpcRequest(input: unknown): IpcRequest {
  const v = record(input, ["method", "args"]);
  const method = oneOf(v.method, METHODS);
  if (!Array.isArray(v.args) || v.args.length > 3)
    throw new Error("Invalid argument list");
  const args = v.args;
  let result: unknown[] = [];
  switch (method) {
    case "getSnapshot":
    case "importMedia":
    case "preparePreview":
    case "exportVideo":
    case "openProject":
    case "chooseModel":
      if (args.length) throw new Error("Unexpected argument");
      break;
    case "applyEdit":
      if (args.length !== 1) throw new Error("Expected edit");
      result = [parseEditCommand(args[0])];
      break;
    case "downloadModel":
      if (args.length > 1) throw new Error("Expected model choice");
      result = args.length ? [oneOf(args[0], ["small", "turbo"])] : [];
      break;
    case "transcribe":
      if (args.length !== 2 && args.length !== 3)
        throw new Error("Expected source and language");
      result = [id(args[0]), oneOf(args[1], ["auto", "en", "zh"])];
      if (args.length === 3) result.push(parseTranscriptionOptions(args[2]));
      break;
    case "prepareSourcePreview":
    case "cancelJob":
    case "relinkMedia":
    case "revealExport":
      if (args.length !== 1) throw new Error("Expected identifier");
      result = [id(args[0])];
      break;
    case "saveProject":
      if (args.length > 1) throw new Error("Unexpected argument");
      result = args.length ? [bool(args[0])] : [];
      break;
    case "importDroppedFiles":
      if (args.length !== 1) throw new Error("Expected dropped files");
      result = [list(args[0], (p) => text(p, 4096), 1000)];
      break;
  }
  return { method, args: result };
}
export function createDispatcher(services: IpcServices = {}) {
  return async (input: unknown, authorized: boolean): Promise<IpcResponse> => {
    if (!authorized)
      return {
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "This document cannot access ClipDeck services",
        },
      };
    let request: IpcRequest;
    try {
      request = parseIpcRequest(input);
    } catch {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "Invalid ClipDeck request" },
      };
    }
    const service = services[request.method];
    if (!service)
      return {
        ok: false,
        error: {
          code: "NOT_READY",
          message: `${request.method} is not ready in this foundation build`,
        },
      };
    try {
      return {
        ok: true,
        value: await (service as (...args: unknown[]) => unknown)(
          ...request.args,
        ),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "FAILED",
          message: publicErrorMessage(error),
        },
      };
    }
  };
}
export function safeSnapshot(
  project: Project = createProject(),
): WorkspaceSnapshot {
  const { history, assets, ...data } = project;
  return {
    project: {
      ...data,
      assets: assets.map(({ fileRef: _, ...asset }) => ({
        ...asset,
        mediaUrl: null,
      })),
    },
    model: {
      status: "notReady",
      id: null,
      message: "Local transcription model has not been prepared",
      progress: null,
    },
    jobs: [],
    save: { dirty: project.revision > 0, displayName: null, recovered: false },
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    capabilities: {
      media: false,
      transcription: false,
      rendering: false,
      persistence: false,
    },
  };
}
