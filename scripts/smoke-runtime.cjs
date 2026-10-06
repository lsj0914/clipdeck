const { app, BrowserWindow, dialog } = require("electron");
// This automated sandbox smoke test chooses the recovery option at the new
// close prompt. Native dialog interaction is verified separately in acceptance.
dialog.showMessageBox = async (_window, options) => {
  assert.equal(options.buttons.length, 3);
  return { response: 1, checkboxChecked: false };
};
app.setAppPath(require("node:path").resolve(__dirname, ".."));
const assert = require("node:assert/strict");
const expected = [
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
  "subscribe",
  "onCloseRequested",
].sort();
let firstWindow = true;
app.on("browser-window-created", (_event, window) => {
  if (!firstWindow) return;
  firstWindow = false;
  window.webContents.once("did-finish-load", async () => {
    try {
      const evidence = await window.webContents.executeJavaScript(`(async()=>{
    const snapshot=await window.clipdeck.getSnapshot();
    let malformed, fakeDrop;
    try { await window.clipdeck.applyEdit({type:'undo',path:'/etc/passwd'}); } catch(e) { malformed=e.code; }
    try { await window.clipdeck.importDroppedFiles([{path:'/etc/passwd'}]); } catch(e) { fakeDrop=e.message; }
    const unsubscribe=window.clipdeck.subscribe(()=>{});unsubscribe();unsubscribe();
    const edited=await window.clipdeck.applyEdit({type:'renameProject',name:'Smoke workspace'});
    const undone=await window.clipdeck.applyEdit({type:'undo'});
    return {keys:Object.keys(window.clipdeck).sort(),requireType:typeof require,processType:typeof process,snapshot,malformed,fakeDrop,edited:edited.project.name,undone:undone.project.name,title:document.title};
   })()`);
      assert.deepEqual(evidence.keys, expected);
      assert.equal(evidence.requireType, "undefined");
      assert.equal(evidence.processType, "undefined");
      assert.ok(
        Object.values(evidence.snapshot.capabilities).every(
          (value) => typeof value === "boolean",
        ),
      );
      assert.equal(evidence.snapshot.capabilities.persistence, true);
      assert.equal(evidence.snapshot.capabilities.media, true);
      assert.equal(evidence.malformed, "INVALID_INPUT");
      assert.ok(evidence.fakeDrop);
      assert.equal(evidence.edited, "Smoke workspace");
      assert.equal(evidence.undone, "Untitled project");
      assert.equal(evidence.snapshot.project.assets.length, 0);
      assert.equal(evidence.snapshot.jobs.length, 0);
      assert.equal(evidence.title, "ClipDeck");
      const prefs = window.webContents.getLastWebPreferences();
      assert.equal(prefs.sandbox, true);
      assert.equal(prefs.contextIsolation, true);
      assert.equal(prefs.nodeIntegration, false);
      assert.equal(prefs.webSecurity, true);
      const attacker = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: require("node:path").resolve("dist/main/preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await attacker.loadFile(
        require("node:path").resolve("dist/renderer/index.html"),
      );
      const denial = await attacker.webContents.executeJavaScript(
        "(async()=>{try{await window.clipdeck.getSnapshot();return null;}catch(e){return e.code;}})()",
      );
      assert.equal(denial, "UNAUTHORIZED");
      attacker.close();
      console.log(
        JSON.stringify({
          event: "desktop-loaded",
          foreignDocumentRejected: true,
          restrictedBridge: true,
          sandbox: true,
          capabilities: evidence.snapshot.capabilities,
          editUndo: true,
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
        }),
      );
      window.once("closed", () => {
        console.log(
          JSON.stringify({
            event: "desktop-closed",
            remainingWindows: BrowserWindow.getAllWindows().length,
          }),
        );
        app.exit(0);
      });
      window.close();
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
});
require("../dist/main/main.cjs");
