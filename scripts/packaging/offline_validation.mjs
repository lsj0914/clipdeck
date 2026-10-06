// Public test-only method probe. Actual packaged main/preload/backend are not replaced.
// Controls public Node APIs and Chromium HTTP-family traffic; not a security boundary
// against hostile native code, Electron utility processes or all kernel syscalls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import dgram from 'node:dgram';
import net from 'node:net';
import path from 'node:path';
import { mkdir, readFile, writeFile, readdir, lstat, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { isExpectedProxyRefusal } from './offline-canary-errors.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  app: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
  'workflow-module': { type: 'string' }, 'timeout-ms': { type: 'string', default: '45000' },
  'emulation-only-control': { type: 'boolean', default: false },
} });
if (values.help || !values.app || !values.output) {
  console.log('Node 24: offline_validation.mjs --app MOVED_ClipDeck.app --output NEW_DIRECTORY [--workflow-module REVIEWED_MODULE.mjs] [--timeout-ms 1200000] [--emulation-only-control]');
  console.log('Test instrumentation only. API-layer network rejection plus worker OS denial; never whole-tree kernel denial or automatic workflow acceptance.');
  process.exit(values.help ? 0 : 1);
}
const timeoutMs = Number(values['timeout-ms']);
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 45000 && timeoutMs <= 3600000, 'Timeout must be 45000..3600000 ms');
const app = path.resolve(values.app), out = path.resolve(values.output);
const emulationOnlyControl = values['emulation-only-control'];
const execute = promisify(execFile);
async function payload(root) {
  const rows = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
      const filename = path.join(directory,entry.name), relative = path.relative(root,filename), info = await lstat(filename);
      if (info.isSymbolicLink()) rows.push({path:relative,symlink:await readlink(filename)});
      else if (info.isDirectory()) {rows.push({path:relative,directory:true,mode:info.mode & 0o777});await walk(filename);}
      else rows.push({path:relative,bytes:info.size,mode:info.mode & 0o777,sha256:createHash('sha256').update(await readFile(filename)).digest('hex')});
    }
  }
  await walk(root);return rows;
}
const beforePayload = await payload(app);
await execute('/usr/bin/codesign',['--verify','--deep','--strict',app]);
await mkdir(out);
for (const name of ['home', 'data', 'tmp', 'hf']) await mkdir(path.join(out, name));
let hits = 0, udpHits = 0;
const canary = http.createServer((req, res) => { hits++; res.end('local-canary'); });
canary.listen(0, '127.0.0.1'); await once(canary, 'listening');
const udp = dgram.createSocket('udp4'); udp.on('message', () => udpHits++);
udp.bind(0, '127.0.0.1'); await once(udp, 'listening');
const url = `http://127.0.0.1:${canary.address().port}/offline-canary`;
assert.equal(await (await fetch(url)).text(), 'local-canary');
const udpSender = dgram.createSocket('udp4');
await new Promise((resolve, reject) => udpSender.send(Buffer.from('baseline'), udp.address().port, '127.0.0.1', error => error ? reject(error) : resolve()));
await new Promise(resolve => setTimeout(resolve, 30)); udpSender.close(); assert.equal(udpHits, 1);
const baseline = { hits, udpHits };
let rejectedProxyConnections = 0;
const rejectProxy = net.createServer(socket => { rejectedProxyConnections++; socket.destroy(); });
rejectProxy.listen(0, '127.0.0.1'); await once(rejectProxy, 'listening');
const proxyPort = rejectProxy.address().port;
async function port() { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const p = server.address().port; await new Promise(r => server.close(r)); return p; }
const mainPort = await port(), rendererPort = await port();
const args = [`--user-data-dir=${out}/data`, `--inspect-brk=127.0.0.1:${mainPort}`, `--remote-debugging-port=${rendererPort}`, ...(emulationOnlyControl ? [] : [`--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', `--log-net-log=${out}/chromium-netlog.json`])];
const env = { PATH: '/usr/bin:/bin', HOME: out + '/home', TMPDIR: out + '/tmp/', HF_HOME: out + '/hf', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', ORT_DISABLE_TELEMETRY: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', ELECTRON_ENABLE_LOGGING: '1' };
const child = spawn(path.join(app, 'Contents/MacOS/ClipDeck'), args, { env, cwd: out, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '', stdout = ''; child.stderr.on('data', b => stderr += b); child.stdout.on('data', b => stdout += b);
const exited = once(child, 'exit'); const watchdog = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
async function discover(p, kind) { const until = Date.now() + 20000; while (Date.now() < until) { if (child.exitCode !== null) throw new Error(stderr); try { const list = await (await fetch(`http://127.0.0.1:${p}/json/list`)).json(); const target = list.find(t => kind === 'main' || (t.type === 'page' && t.url.startsWith('file:'))); if (target) return target; } catch {} await new Promise(r => setTimeout(r, 100)); } throw new Error('No inspector target ' + kind + ': ' + stderr); }
async function protocol(url) {
  const ws = new WebSocket(url); await once(ws, 'open'); let id = 0; const pending = new Map(), events = new Map();
  ws.addEventListener('close', () => { for (const callback of pending.values()) callback.reject(new Error('Inspector closed: ' + stderr)); for (const callback of events.values()) callback({ closed: true }); });
  ws.addEventListener('message', e => { const result = JSON.parse(e.data); if (result.id) { const callback = pending.get(result.id); pending.delete(result.id); result.error ? callback.reject(result.error) : callback.resolve(result.result); } else { const callback = events.get(result.method); if (callback) { events.delete(result.method); callback(result.params); } } });
  return { send: (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); }), event: method => new Promise(resolve => events.set(method, resolve)), close: () => ws.close() };
}
async function evaluate(client, expression) { const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
let main, renderer;
try {
  main = await protocol((await discover(mainPort, 'main')).webSocketDebuggerUrl);
  console.log('Inspector attached');
  const paused = main.event('Debugger.paused'); await main.send('Debugger.enable');
  console.log('Debugger enabled');
  const runWaiting = main.send('Runtime.runIfWaitingForDebugger');
  const pause = await paused;
  console.log('Paused before application code: ' + JSON.stringify(pause.callFrames?.[0]?.location));
  async function evaluatePaused(expression) { const result = await main.send('Debugger.evaluateOnCallFrame', { callFrameId: pause.callFrames[0].callFrameId, expression, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
  const guard = await evaluatePaused(await readFile(path.join(here, 'offline-node-guard.js'), 'utf8'));
  console.log('Node guard installed');
  const configured = await evaluatePaused(`(() => {const {app,session}=process.mainModule.require('electron');globalThis.__clipdeckOfflineProbe.sessions=0;app.on('session-created', ses=>{ses.enableNetworkEmulation({offline:true});globalThis.__clipdeckOfflineProbe.sessions++;});app.on('ready',()=>session.defaultSession.enableNetworkEmulation({offline:true}));return {beforeAppReady:!app.isReady(),mainModule:process.mainModule.filename};})()`);
  assert.equal(configured.beforeAppReady, true); assert.ok(configured.mainModule.startsWith(app + path.sep));
  await main.send('Debugger.resume');
  await runWaiting;
  console.log('Application resumed');
  renderer = await protocol((await discover(rendererPort, 'renderer')).webSocketDebuggerUrl);
  let state; const until = Date.now() + 15000;
  while (Date.now() < until) { state = await evaluate(renderer, `(async()=>window.clipdeck?{snapshot:await window.clipdeck.getSnapshot(),require:typeof require,process:typeof process,title:document.title}:null)()`); if (state) break; await new Promise(r => setTimeout(r, 100)); }
  assert.ok(state); assert.equal(state.title, 'ClipDeck'); assert.equal(state.require, 'undefined'); assert.equal(state.process, 'undefined');
  const preferences = await evaluate(main, `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()`);
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.webSecurity, true);
  if (emulationOnlyControl) {
    // This control touches only the already-proven loopback canary. It must
    // expose the insufficient control, never issue an external request.
    const chromium = await evaluate(main, `(async()=>{const {net,session}=process.mainModule.require('electron');const results={};for(const [name,fn] of [['default net.fetch',()=>net.fetch(${JSON.stringify(url)})],['fresh session fetch',()=>session.fromPartition('offline-validation-control').fetch(${JSON.stringify(url)})]]){try{results[name]=await(await fn()).text()}catch(e){results[name]=String(e)}}return results})()`);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(chromium['fresh session fetch'], 'local-canary'); assert.equal(hits, baseline.hits + 1);
    const proof = { status: 'negative_control_session_emulation_insufficient', app, args, chromium, canary: { baseline, after: { hits, udpHits } }, preferences, beforeAppReady: configured.beforeAppReady, wholeApplicationKernelDenial: false };
    renderer.close(); renderer = null; await evaluate(main, `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].close();true`); main.close(); main = null;
    const [code, signal] = await exited; proof.close = { code, signal }; assert.equal(code, 0);
    const afterPayload = await payload(app);assert.deepEqual(afterPayload,beforePayload);await execute('/usr/bin/codesign',['--verify','--deep','--strict',app]);
    await writeFile(path.join(out,'resource-integrity.json'),JSON.stringify({unchanged:true,files:beforePayload.length,strictDeepSignature:true})+'\n');
    await writeFile(path.join(out, 'proof.json'), JSON.stringify(proof, null, 2) + '\n'); console.log(JSON.stringify(proof));
  }
  if (!emulationOnlyControl) {
  async function runCanaries() {
  const nodeAttempts = await evaluate(main, `(async()=>{const get=process.getBuiltinModule.bind(process);const results={};async function attempt(name,fn){try{await fn();results[name]='ALLOWED'}catch(e){results[name]=e.code||String(e)}}await attempt('Node fetch',()=>fetch(${JSON.stringify(url)}));await attempt('Node HTTP',()=>get('node:http').get(${JSON.stringify(url)}));await attempt('Node HTTPS',()=>get('node:https').get('https://offline-canary.invalid'));await attempt('raw TCP IPv4',()=>get('node:net').connect({host:'127.0.0.1',port:${canary.address().port}}));await attempt('raw TCP IPv6',()=>new(get('node:net').Socket)().connect({host:'::1',port:${canary.address().port}}));await attempt('TLS',()=>get('node:tls').connect({host:'127.0.0.1',port:${canary.address().port}}));await attempt('UDP',()=>{const socket=get('node:dgram').createSocket('udp4');try{socket.send(Buffer.from('deny'),${udp.address().port},'127.0.0.1')}finally{socket.close()}});await attempt('DNS',()=>get('node:dns').resolve4('offline-canary.invalid',()=>{}));await attempt('DNS promises',()=>get('node:dns').promises.resolve4('offline-canary.invalid'));await attempt('Node WebSocket',()=>new WebSocket(${JSON.stringify(url.replace('http:', 'ws:'))}));return results})()`);
  assert.ok(Object.values(nodeAttempts).every(code => code === 'ERR_CLIPDECK_TEST_OFFLINE'));
  const chromium = await evaluate(main, `(async()=>{const {net,session}=process.mainModule.require('electron');const ses=session.fromPartition('offline-validation-canary');const results={};for(const [name,fn] of [['default net.fetch',()=>net.fetch(${JSON.stringify(url)})],['fresh session fetch',()=>ses.fetch(${JSON.stringify(url)})],['fresh session HTTPS',()=>ses.fetch('https://offline-canary.invalid')],['fresh session WebSocket',()=>new Promise((resolve,reject)=>{const ws=new net.WebSocket(${JSON.stringify(url.replace('http:', 'ws:'))});ws.onopen=()=>{ws.close();resolve('connected')};ws.onerror=()=>reject(new Error('WebSocket rejected'));setTimeout(()=>reject(new Error('WebSocket timeout')),1500)})]]){try{await fn();results[name]='ALLOWED'}catch(e){results[name]=String(e)}}return results})()`);

  assert.ok(Object.values(chromium).every(error => error !== 'ALLOWED'));
  assert.ok(isExpectedProxyRefusal(chromium['fresh session fetch']), chromium['fresh session fetch']);
  const rendererAttempt = await evaluate(renderer, `(async()=>{try{await fetch(${JSON.stringify(url)});return 'ALLOWED'}catch(e){return String(e)}})()`);
  assert.notEqual(rendererAttempt, 'ALLOWED');
  const chromiumDNS = await evaluate(main, `(async()=>{try{await process.mainModule.require('electron').net.resolveHost('example.com',{source:'dns',cacheUsage:'disallowed'});return 'ALLOWED'}catch(e){return String(e)}})()`);
  assert.match(chromiumDNS, /ERR_NAME_NOT_RESOLVED/);
  assert.deepEqual({hits,udpHits},baseline);
  return {nodeAttempts,chromium,chromiumDNS,rendererAttempt};
  }
  const beforeCanaries = await runCanaries();
  const beforeWorkflow = await evaluate(main, `({attempts:globalThis.__clipdeckOfflineProbe.attempts.length,children:globalThis.__clipdeckOfflineProbe.childLaunches.length})`);
  let workflowReceipt = null;
  if (values['workflow-module']) {
    const workflow = await import(pathToFileURL(path.resolve(values['workflow-module'])).href);
    assert.equal(typeof workflow.default,'function','Workflow module must export an async default function');
    workflowReceipt = await workflow.default({ app, out, main, renderer, evaluate });
  }
  const afterWorkflow = await evaluate(main, `({attempts:globalThis.__clipdeckOfflineProbe.attempts.length,children:globalThis.__clipdeckOfflineProbe.childLaunches.length})`);
  const afterCanaries = await runCanaries();
  const {nodeAttempts,chromium,chromiumDNS,rendererAttempt} = afterCanaries;
  await new Promise(resolve => rejectProxy.close(resolve));
  const proxyStopped = await evaluate(main, `(async()=>{try{await process.mainModule.require('electron').session.fromPartition('offline-validation-proxy-stopped').fetch(${JSON.stringify(url)});return 'ALLOWED'}catch(e){return String(e)}})()`);
  assert.match(proxyStopped, /ERR_PROXY_CONNECTION_FAILED/);
  await new Promise(r => setTimeout(r, 100)); assert.deepEqual({ hits, udpHits }, baseline);
  const trace = await evaluate(main, `({attempts:globalThis.__clipdeckOfflineProbe.attempts,sessions:globalThis.__clipdeckOfflineProbe.sessions,childLaunches:globalThis.__clipdeckOfflineProbe.childLaunches})`);
  assert.ok(rejectedProxyConnections > 0);
  const proxyResolution = await evaluate(main, `process.mainModule.require('electron').session.fromPartition('offline-validation-canary').resolveProxy(${JSON.stringify(url)})`);
  assert.equal(proxyResolution, `PROXY 127.0.0.1:${proxyPort}`);
  const naturalWorkflowAttempts = trace.attempts.slice(beforeWorkflow.attempts,afterWorkflow.attempts);
  const workflowChildren = trace.childLaunches.slice(beforeWorkflow.children,afterWorkflow.children);
  assert.equal(naturalWorkflowAttempts.length,0,'Unexpected product networking during workflow');
  assert.ok(trace.childLaunches.every(launch=>launch.allowed),'Unaccounted Node child path');
  const proof = { beforeCanaries, afterCanaries, beforeWorkflow, afterWorkflow, naturalWorkflowAttempts, workflowChildren, workflowReceipt, status: 'method_proof_only', app, args, env, firstPause: { reason: pause.reason, firstFrame: pause.callFrames[0].functionName, location: pause.callFrames[0].location }, guard, configured, state, preferences, nodeAttempts, chromium, chromiumDNS, rendererAttempt, canary: { baseline, after: { hits, udpHits } }, rejectingProxy: { proxyResolution, connections: rejectedProxyConnections, noForwardingCode: true, stoppedProxyFailure: proxyStopped }, trace, wholeApplicationKernelDenial: false, workflowAcceptance: false };
  await writeFile(path.join(out, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  renderer.close(); renderer = null;
  await evaluate(main, `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].close();true`); main.close(); main = null;
  const [code, signal] = await exited; assert.equal(code, 0); proof.close = { code, signal };
  const afterPayload = await payload(app);assert.deepEqual(afterPayload,beforePayload);await execute('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  await writeFile(path.join(out,'resource-integrity.json'),JSON.stringify({unchanged:true,files:beforePayload.length,strictDeepSignature:true})+'\n');
  await writeFile(path.join(out, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify({ status: proof.status, out, nodeAttempts, chromium, canary: proof.canary, close: proof.close }));
  }
} catch (error) {
  await writeFile(path.join(out, 'failure.json'), JSON.stringify({
    status: 'method_probe_failed', error: String(error), stack: error?.stack,
    canary: { baseline, after: { hits, udpHits } }, rejectingProxyConnections: rejectedProxyConnections,
    workflowAcceptance: false, wholeApplicationKernelDenial: false,
  }, null, 2) + '\n');
  throw error;
}
finally { clearTimeout(watchdog); if (child.exitCode === null) child.kill('SIGTERM'); main?.close(); renderer?.close(); canary.close(); udp.close(); if (rejectProxy.listening) rejectProxy.close(); await writeFile(path.join(out, 'stderr.log'), stderr); await writeFile(path.join(out, 'stdout.log'), stdout); }
