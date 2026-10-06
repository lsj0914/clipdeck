// Real Chromium decode/seek test of the product's registered, range-capable protocol.
// Usage: Electron scripts/smoke-media.cjs --fixture-root=<source-playback fixture directory> --receipt=<output JSON> --user-data-dir=<isolated profile>
const { app, BrowserWindow } = require("electron");
const path = require("node:path"),
  fs = require("node:fs");
const assert = require("node:assert/strict");
app.setAppPath(path.resolve(__dirname, ".."));
const args = Object.fromEntries(
  process.argv
    .filter((x) => x.startsWith("--") && x.includes("="))
    .map((x) => {
      const i = x.indexOf("=");
      return [x.slice(2, i), x.slice(i + 1)];
    }),
);
if (!args["fixture-root"] || !args.receipt)
  throw new Error("Explicit fixture root and receipt path required");
const root = path.resolve(args["fixture-root"]),
  evidence = [];
let firstWindow = true;
app.on("browser-window-created", (_event, window) => {
  if (!firstWindow) return;
  firstWindow = false;
  window.webContents.once("did-finish-load", async () => {
    try {
      const workspace = main.getWorkspace();
      const files = fs
        .readdirSync(root)
        .filter((f) => /\.(mp4|mov|mkv|webm)$/i.test(f));
      assert.ok(files.length >= 7);
      await workspace.importPaths(files.map((f) => path.join(root, f)));
      for (const asset of workspace.project.assets) {
        const id = await workspace.prepareSourcePreview(asset.id);
        await workspace.jobs.wait(id);
        const job = workspace.jobs.list().find((j) => j.id === id);
        assert.equal(job.status, "completed", job.error);
        const url = workspace
          .snapshot()
          .project.assets.find((a) => a.id === asset.id).mediaUrl;
        const result = await window.webContents.executeJavaScript(`(async()=>{
    const v=document.createElement('video');v.muted=true;v.style.width='320px';document.body.appendChild(v);
    const events=[];for(const name of ['loadedmetadata','playing','seeked','error'])v.addEventListener(name,()=>events.push({name,time:v.currentTime,w:v.videoWidth,h:v.videoHeight}));
    const event=name=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Timed out '+name)),10000);v.addEventListener(name,()=>{clearTimeout(t);resolve();},{once:true});});
    const frame=()=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('No decoded video frame')),10000);v.requestVideoFrameCallback((_,m)=>{clearTimeout(t);resolve({mediaTime:m.mediaTime,width:m.width,height:m.height,presentedFrames:m.presentedFrames});});});
    v.src=${JSON.stringify(url)};const first=frame();await v.play();const firstFrame=await first;
    const seek=event('seeked');v.currentTime=2.1;await seek;const postSeek=await frame();v.pause();
    const result={duration:v.duration,width:v.videoWidth,height:v.videoHeight,firstFrame,postSeek,events,error:v.error?.message??null};v.remove();return result;
   })()`);
        assert.ok(result.width > 0 && result.height > 0);
        assert.ok(result.firstFrame.presentedFrames > 0);
        assert.ok(Math.abs(result.postSeek.mediaTime - 2.1) < 0.25);
        assert.equal(result.error, null);
        evidence.push({
          name: asset.name,
          source: {
            durationMs: asset.durationMs,
            width: asset.width,
            height: asset.height,
            rotation: asset.rotation,
            sar: asset.sampleAspectRatio,
          },
          jobKind: job.kind,
          receipt: workspace.rendering.receipt(id),
          playback: result,
        });
      }
      const foreign = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      await foreign.loadFile(path.resolve("dist/renderer/index.html"));
      const guardedUrl = workspace.snapshot().project.assets.at(-1).mediaUrl;
      const denied = await foreign.webContents.executeJavaScript(
        `new Promise(resolve=>{const v=document.createElement('video');v.addEventListener('error',()=>resolve(true),{once:true});v.addEventListener('loadeddata',()=>resolve(false),{once:true});setTimeout(()=>resolve(false),3000);v.src=${JSON.stringify(guardedUrl)};v.load();})`,
      );
      assert.equal(
        denied,
        true,
        "Foreign window must not read an approved media capability",
      );
      foreign.destroy();
      fs.writeFileSync(
        args.receipt,
        JSON.stringify(
          {
            foreignMediaDenied: true,
            electron: process.versions.electron,
            scope:
              "actual product media protocol and native source preparation",
            security: window.webContents.getLastWebPreferences(),
            cases: evidence,
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          event: "product-source-protocol",
          passed: evidence.length,
          receipt: args.receipt,
        }),
      );
      await workspace.close();
      app.exit(0);
    } catch (error) {
      console.error(error);
      fs.writeFileSync(
        args.receipt,
        JSON.stringify({ error: String(error), cases: evidence }, null, 2),
      );
      app.exit(1);
    }
  });
});
const main = require("../dist/main/main.cjs");
