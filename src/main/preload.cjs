const { contextBridge, ipcRenderer, webUtils } = require("electron");
const request = async (method, args = []) => {
  const response = await ipcRenderer.invoke("clipdeck:request", {
    method,
    args,
  });
  if (!response || response.ok !== true) {
    // contextBridge strips custom fields from Error instances; plain rejections
    // preserve a stable code/message boundary for the renderer.
    throw Object.freeze({
      code: response?.error?.code || "FAILED",
      message: response?.error?.message || "Invalid service response",
    });
  }
  return response.value;
};
const api = {
  getSnapshot: () => request("getSnapshot"),
  importMedia: () => request("importMedia"),
  importDroppedFiles: (files) => {
    if (!Array.isArray(files) || files.length > 1000)
      return Promise.reject(new Error("Invalid dropped files"));
    try {
      const paths = files.map((file) => {
        const path = webUtils.getPathForFile(file);
        if (!path) throw new Error("Only actual local files can be imported");
        return path;
      });
      return request("importDroppedFiles", [paths]);
    } catch (error) {
      return Promise.reject(error);
    }
  },
  applyEdit: (command) => request("applyEdit", [command]),
  transcribe: (assetId, language, options) =>
    request(
      "transcribe",
      options === undefined
        ? [assetId, language]
        : [assetId, language, options],
    ),
  prepareSourcePreview: (assetId) => request("prepareSourcePreview", [assetId]),
  preparePreview: () => request("preparePreview"),
  exportVideo: () => request("exportVideo"),
  cancelJob: (jobId) => request("cancelJob", [jobId]),
  openProject: () => request("openProject"),
  saveProject: (asNew) =>
    request("saveProject", asNew === undefined ? [] : [asNew]),
  relinkMedia: (assetId) => request("relinkMedia", [assetId]),
  chooseModel: () => request("chooseModel"),
  downloadModel: (choice) =>
    request("downloadModel", choice === undefined ? [] : [choice]),
  revealExport: (jobId) => request("revealExport", [jobId]),
  onCloseRequested: (listener) => {
    if (typeof listener !== "function") throw new Error("Expected close preparation listener");
    const receive = (_event, action, token) => {
      if (!["apply", "discard", "resume"].includes(action)) return;
      if (action !== "resume" && (typeof token !== "string" || !/^[a-f0-9-]{36}$/.test(token))) return;
      void Promise.resolve().then(() => listener(action)).then((result) => {
        if (token) ipcRenderer.send("clipdeck:close-response", token, result);
      }).catch((error) => {
        if (token) ipcRenderer.send("clipdeck:close-response", token, {
          ready: false, locale: "en", error: String(error?.message || "Could not prepare edits for closing").slice(0, 500),
        });
      });
    };
    ipcRenderer.on("clipdeck:close-request", receive);
    return () => ipcRenderer.removeListener("clipdeck:close-request", receive);
  },
  subscribe: (listener) => {
    if (typeof listener !== "function")
      throw new Error("Expected snapshot listener");
    const receive = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on("clipdeck:snapshot", receive);
    let active = true;
    return () => {
      if (active) {
        active = false;
        ipcRenderer.removeListener("clipdeck:snapshot", receive);
      }
    };
  },
};
contextBridge.exposeInMainWorld("clipdeck", Object.freeze(api));
