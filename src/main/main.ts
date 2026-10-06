import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  dialog,
  protocol,
  shell,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDispatcher } from "./ipc";
import { WorkspaceService } from "./services/workspace";
import { resolveRuntime } from "./services/runtime";
import { CloseCoordinator } from "./services/close";
import { RendererCloseBridge } from "./renderer-close";
import { publicErrorMessage } from "./errors";
import { IPC_REQUEST, IPC_SNAPSHOT, IPC_CLOSE_REQUEST, IPC_CLOSE_RESPONSE } from "../shared/contracts";
protocol.registerSchemesAsPrivileged([
  {
    scheme: "clipdeck-media",
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);
// One owner per user-data profile: recovery and transient media cleanup must not
// race a second application instance using the same directory.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => {
  const current = BrowserWindow.getAllWindows()[0];
  if (current) {
    if (current.isMinimized()) current.restore();
    current.show();
    current.focus();
  }
});
let workspace: WorkspaceService | null = null;
let ownerWebContentsId: number | null = null;
let quitAllowed = false;
export function getWorkspace(): WorkspaceService {
  if (!workspace) throw new Error("Desktop workspace has not initialized");
  return workspace;
}
const rendererPath = path.join(__dirname, "../renderer/index.html");
const rendererURL = pathToFileURL(rendererPath).href;
const rendererResourcePrefix = pathToFileURL(
  path.join(__dirname, "../renderer/"),
).href;
export function isTrustedSender(
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
  window: BrowserWindow,
): boolean {
  return (
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === rendererURL
  );
}
export function createDesktopWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#17191b",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  ownerWebContentsId = window.webContents.id;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererURL) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  const runtime = resolveRuntime({
    appRoot: app.getAppPath(),
    resourcesRoot: process.resourcesPath,
    packaged: app.isPackaged,
  });
  const mediaFilters = [
    {
      name: "Video",
      extensions: ["mp4", "mov", "mkv", "webm", "m4v", "avi", "mts", "m2ts"],
    },
    { name: "All files", extensions: ["*"] },
  ];
  workspace = new WorkspaceService({
    runtime,
    dataRoot: app.getPath("userData"),
    notify: (snapshot) => {
      if (!window.isDestroyed())
        window.webContents.send(IPC_SNAPSHOT, snapshot);
    },
    dialogs: {
      export: async () => {
        const result = await dialog.showSaveDialog(window, {
          title: "Export assembled video",
          defaultPath: "ClipDeck-export.mp4",
          filters: [{ name: "MP4 video", extensions: ["mp4"] }],
          properties: ["showOverwriteConfirmation"],
        });
        return result.canceled ? null : (result.filePath ?? null);
      },
      reveal: (file) => shell.showItemInFolder(file),
      media: async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "Import videos",
          properties: ["openFile", "multiSelections"],
          filters: mediaFilters,
        });
        return result.canceled ? [] : result.filePaths;
      },
      open: async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "Open ClipDeck project",
          properties: ["openFile"],
          filters: [{ name: "ClipDeck project", extensions: ["clipdeck"] }],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      save: async (current) => {
        const result = await dialog.showSaveDialog(window, {
          title: "Save ClipDeck project",
          defaultPath: current ?? "Untitled.clipdeck",
          filters: [{ name: "ClipDeck project", extensions: ["clipdeck"] }],
        });
        return result.canceled ? null : (result.filePath ?? null);
      },
      relink: async (asset) => {
        const result = await dialog.showOpenDialog(window, {
          title: `Relink ${asset.name}`,
          properties: ["openFile"],
          filters: mediaFilters,
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      model: async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "Choose complete faster-whisper model folder",
          properties: ["openDirectory"],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
    },
  });
  const activeWorkspace = workspace;
  let locale: "en" | "zh" = app.getLocale().startsWith("zh") ? "zh" : "en";
  const translated = (en: string, zh: string) => locale === "zh" ? zh : en;
  const closeBridge = new RendererCloseBridge((action, token) => {
    if (window.isDestroyed()) throw new Error("The editor is unavailable.");
    window.webContents.send(IPC_CLOSE_REQUEST, action, token);
  });
  const acknowledgeClose = (event: Electron.IpcMainEvent, token: unknown, result: unknown) => {
    if (isTrustedSender(event, window)) closeBridge.receive(token, result);
  };
  ipcMain.on(IPC_CLOSE_RESPONSE, acknowledgeClose);
  const closer = new CloseCoordinator({
    prepare: async (mode) => {
      const result = await closeBridge.prepare(mode);
      locale = result.locale;
      if (result.ready) activeWorkspace.beginClose();
      return result;
    },
    confirmDiscard: async (error) => {
      const result = await dialog.showMessageBox(window, {
        type: "warning",
        message: translated("Unapplied edits need attention", "未应用的编辑需要处理"),
        detail: error,
        buttons: [translated("Keep editing", "继续编辑"), translated("Discard unapplied edits", "放弃未应用的编辑")],
        defaultId: 0, cancelId: 0,
      });
      return result.response === 1;
    },
    hasRunningJobs: () => activeWorkspace.hasRunningWork(),
    confirmCancelJobs: async () => {
      const result = await dialog.showMessageBox(window, {
        type: "question", message: translated("Tasks are still running", "还有任务正在处理"),
        detail: translated("Keep ClipDeck open to finish them, or cancel the unfinished tasks before closing. Original videos are kept.", "可继续等待完成，或取消未完成的任务后关闭。原视频会保留。"),
        buttons: [translated("Keep working", "继续处理"), translated("Cancel tasks and close", "取消任务并关闭")],
        defaultId: 0, cancelId: 0,
      });
      return result.response === 1;
    },
    cancelJobs: () => activeWorkspace.cancelWork(),
    hasUnsavedChanges: () => {
      const p = activeWorkspace.project, s = activeWorkspace.snapshot().save;
      const untouched = p.revision === 0 && p.name === "Untitled project" && !p.assets.length && !p.cuts.length && !p.transcripts.length && p.savedAt === null && !s.recovered;
      return !!s.error || (!untouched && s.dirty);
    },
    chooseSave: async () => {
      const result = await dialog.showMessageBox(window, {
        type: "question", message: translated("Save this project before closing?", "关闭前保存项目吗？"),
        detail: translated("Save a project file, or keep a local recovery draft for the next launch. Project files reference original media; keep those videos too.", "可保存项目文件，也可保留本地恢复草稿供下次继续。项目文件引用原素材，请同时保管原视频。"),
        buttons: [translated("Save project", "保存项目"), translated("Keep local draft and close", "保留本地草稿并关闭"), translated("Cancel", "取消")],
        defaultId: 0, cancelId: 2,
      });
      return result.response === 0 ? "save" : result.response === 1 ? "recovery" : "cancel";
    },
    save: async () => {
      const saved = await activeWorkspace.saveProject();
      return !saved.save.dirty && !saved.save.error && !!saved.save.displayName;
    },
    preserveRecovery: () => activeWorkspace.close(),
    reportFailure: async (error) => {
      await dialog.showMessageBox(window, {
        type: "error", message: translated("ClipDeck could not safely close", "暂时无法安全关闭 ClipDeck"),
        detail: translated("Your window will stay open. ", "窗口将保持打开。") + publicErrorMessage(error),
        buttons: [translated("Back to editing", "返回编辑")],
      });
    },
    resume: () => { activeWorkspace.resumeAfterClose(); closeBridge.resume(); },
  });
  let closeAllowed = false;
  window.on("close", (event) => {
    if (closeAllowed) return;
    event.preventDefault();
    void closer.request().then((allowed) => {
      if (!allowed || window.isDestroyed()) return;
      closeAllowed = true;
      quitAllowed = true;
      window.close();
    });
  });
  const dispatch = createDispatcher(activeWorkspace.services());
  ipcMain.removeHandler(IPC_REQUEST);
  ipcMain.handle(IPC_REQUEST, (event, input) =>
    dispatch(input, isTrustedSender(event, window)),
  );
  window.on("closed", () => {
    closeBridge.dispose();
    ipcMain.removeListener(IPC_CLOSE_RESPONSE, acknowledgeClose);
    ipcMain.removeHandler(IPC_REQUEST);
    if (workspace === activeWorkspace) workspace = null;
    ownerWebContentsId = null;
  });
  void activeWorkspace.initialize().then(() => window.loadFile(rendererPath));
  return window;
}
app.whenReady().then(() => {
  protocol.handle("clipdeck-media", (request) =>
    workspace
      ? workspace.rendering.protocol.handle(request, true)
      : new Response(null, { status: 403 }),
  );
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
    callback({
      cancel:
        !details.url.startsWith(rendererResourcePrefix) &&
        !details.url.startsWith("devtools:") &&
        !(
          details.webContentsId === ownerWebContentsId &&
          details.resourceType === "media" &&
          details.frame?.url === rendererURL &&
          workspace?.rendering.protocol.accepts(details.url)
        ),
    }),
  );
  createDesktopWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createDesktopWindow();
  });
});
app.on("before-quit", (event) => {
  if (!quitAllowed && workspace) {
    event.preventDefault();
    BrowserWindow.getAllWindows()[0]?.close();
  }
});
app.on("window-all-closed", () => app.quit());
