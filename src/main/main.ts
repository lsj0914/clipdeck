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
import { IPC_REQUEST, IPC_SNAPSHOT } from "../shared/contracts";
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
  event: Electron.IpcMainInvokeEvent,
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
  const dispatch = createDispatcher(activeWorkspace.services());
  ipcMain.removeHandler(IPC_REQUEST);
  ipcMain.handle(IPC_REQUEST, (event, input) =>
    dispatch(input, isTrustedSender(event, window)),
  );
  window.on("closed", () => {
    ipcMain.removeHandler(IPC_REQUEST);
    void activeWorkspace.close().catch(() => {});
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
let quitting = false;
app.on("before-quit", (event) => {
  if (workspace && !quitting) {
    event.preventDefault();
    quitting = true;
    void workspace.close().finally(() => app.quit());
  }
});
app.on("window-all-closed", () => app.quit());
