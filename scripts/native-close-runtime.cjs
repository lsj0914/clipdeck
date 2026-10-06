// Isolated native lifecycle integration. Dialog answers are controlled test
// inputs; this is not a substitute for the release's visible GUI acceptance.
const { app, BrowserWindow, dialog } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
app.setAppPath(path.resolve(__dirname, ".."));
const evidence = { nativeQuitCancelled: false, nativeSaveCancelled: false,
  runningTaskPreserved: false, recoveryFailureKeepsWindow: false,
  focusedTitleRecovered: false, closeRetried: false };
let scenario = "cancel-quit", window, service;
const dialogs = [];
dialog.showMessageBox = async (_window, options) => {
  dialogs.push({ scenario, message: options.message, buttonCount: options.buttons.length });
  if (options.buttons.length === 1) return { response: 0, checkboxChecked: false };
  if (options.buttons.length === 2) { assert.equal(scenario, "keep-task"); return { response: 0, checkboxChecked: false }; }
  assert.equal(options.buttons.length, 3);
  return { response: scenario === "cancel-quit" ? 2 : scenario === "cancel-save" ? 0 : 1, checkboxChecked: false };
};
dialog.showSaveDialog = async () => { assert.equal(scenario, "cancel-save"); return { canceled: true }; };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test) {
  for (let attempt = 0; attempt < 250; attempt++) { if (await test()) return; await delay(20); }
  throw new Error("Native close integration timed out waiting for state");
}
async function remainsOpen(action) {
  const count = dialogs.length;
  action();
  await until(async () => dialogs.length > count && !window.isDestroyed() &&
    await window.webContents.executeJavaScript("!document.querySelector('.app').hasAttribute('inert')"));
  assert.equal(window.isDestroyed(), false);
}
app.on("browser-window-created", (_event, created) => {
  if (window) return;
  window = created;
  created.hide();
  created.webContents.once("did-finish-load", () => {
    void (async () => {
      service = require("../dist/main/main.cjs").getWorkspace();
      await until(() => created.webContents.executeJavaScript("!!document.querySelector('.project-identity input') && !document.querySelector('.project-identity input').disabled"));
      // An uncontrolled title is still a renderer-only edit until blur/close.
      await created.webContents.executeJavaScript("document.querySelector('.project-identity input').value='Focused native close draft'");
      await remainsOpen(() => app.quit());
      assert.equal(service.project.name, "Focused native close draft");
      evidence.nativeQuitCancelled = true;
      scenario = "cancel-save";
      await remainsOpen(() => created.close());
      evidence.nativeSaveCancelled = true;
      scenario = "keep-task";
      const job = service.jobs.start("transcription", {}, async (ctx) => {
        await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
      });
      await until(() => service.jobs.list().find((j) => j.id === job)?.status === "running");
      await remainsOpen(() => created.close());
      assert.equal(service.jobs.list().find((j) => j.id === job).status, "running");
      evidence.runningTaskPreserved = true;
      await service.jobs.cancel(job);
      scenario = "failed-recovery";
      const recovery = path.join(app.getPath("userData"), "recovery.json");
      await fs.rename(recovery, `${recovery}.preserved-test-backup`);
      await fs.mkdir(recovery);
      await remainsOpen(() => created.close());
      assert.ok(service.snapshot().save.error);
      assert.equal(service.project.name, "Focused native close draft");
      evidence.recoveryFailureKeepsWindow = true;
      await fs.rmdir(recovery);
      await fs.rename(`${recovery}.preserved-test-backup`, recovery);
      scenario = "successful-retry";
      created.once("closed", () => {
        void fs.readFile(recovery, "utf8").then((bytes) => {
          assert.equal(JSON.parse(bytes).project.name, "Focused native close draft");
          evidence.focusedTitleRecovered = true;
          evidence.closeRetried = true;
          console.log(JSON.stringify({ event: "native-close-integration", ...evidence }));
          app.exit(0);
        }).catch(fail);
      });
      created.close();
    })().catch(fail);
  });
});
function fail(error) { console.error(error); app.exit(1); }
setTimeout(() => fail(new Error("Native close integration timed out")), 30000).unref();
require("../dist/main/main.cjs");
