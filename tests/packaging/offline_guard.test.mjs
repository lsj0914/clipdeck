// Real Node APIs in an isolated child: no Electron backend or successful
// network response is simulated by this test.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { isExpectedProxyRefusal } from '../../scripts/packaging/offline-canary-errors.mjs';
const run = promisify(execFile);
const guard = fileURLToPath(new URL('../../scripts/packaging/offline-node-guard.js', import.meta.url));

test('recognizes the actual socket refusal observed in the moved packaged canary', () => {
  assert.equal(isExpectedProxyRefusal('Error: net::ERR_SOCKET_NOT_CONNECTED'), true);
});

test('retains the previously observed reset and empty-response refusals', () => {
  assert.equal(isExpectedProxyRefusal('Error: net::ERR_CONNECTION_RESET'), true);
  assert.equal(isExpectedProxyRefusal('Error: net::ERR_EMPTY_RESPONSE'), true);
});

test('rejects successful results, unrelated errors and misleading refusal substrings', () => {
  for (const result of [
    'ALLOWED', 'connected', 'local-canary', undefined, null,
    'Error: arbitrary failure', 'Error: net::ERR_UNKNOWN',
    'Error: net::ERR_SOCKET_NOT_CONNECTED_EXTRA',
    'Error: net::ERR_CONNECTION_RESET_EXTRA',
    'unrelated text containing ERR_CONNECTION_RESET',
  ]) assert.equal(isExpectedProxyRefusal(result), false, String(result));
});

test('early guard rejects actual Node HTTP/TCP/UDP/DNS/fetch/child APIs with no destination hit', async () => {
  await assert.doesNotReject(access(guard), 'Public offline guard is not implemented');
  let hits = 0;
  const server = http.createServer((request, response) => { hits++; response.end('live baseline'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/owned-canary`;
    assert.equal(await (await fetch(url)).text(), 'live baseline');
    const program = `
      const fs=require('node:fs');process.resourcesPath='/isolated-test-resources';
      const guardResult=eval(fs.readFileSync(process.argv[1],'utf8'));
      (async()=>{const attempts={};async function attempt(name,operation){try{await operation();attempts[name]='ALLOWED'}catch(error){attempts[name]=error.code}}
      await attempt('http',()=>require('node:http').get(${JSON.stringify(url)}));
      await attempt('https',()=>require('node:https').get('https://owned-canary.invalid'));
      await attempt('tcp',()=>require('node:net').connect({host:'127.0.0.1',port:${server.address().port}}));
      await attempt('tls',()=>require('node:tls').connect({host:'127.0.0.1',port:${server.address().port}}));
      await attempt('udp',()=>{const socket=require('node:dgram').createSocket('udp4');try{socket.send(Buffer.from('blocked'),${server.address().port},'127.0.0.1')}finally{socket.close()}});
      await attempt('dns',()=>require('node:dns').resolve4('owned-canary.invalid',()=>{}));
      await attempt('dnsPromise',()=>require('node:dns').promises.resolve4('owned-canary.invalid'));
      await attempt('fetch',()=>fetch(${JSON.stringify(url)}));
      await attempt('websocket',()=>new WebSocket(${JSON.stringify(url.replace('http:', 'ws:'))}));
      await attempt('unknownChild',()=>require('node:child_process').spawn(process.execPath,['-e','process.exit(0)']));
      console.log(JSON.stringify({attempts,guardResult,childLaunches:globalThis.__clipdeckOfflineProbe.childLaunches}));})().catch(error=>{console.error(error);process.exitCode=1});`;
    const result = await run(process.execPath, ['-e', program, guard]);
    const receipt = JSON.parse(result.stdout);
    assert.equal(Object.keys(receipt.attempts).length, 10);
    assert.ok(Object.values(receipt.attempts).every(code => code === 'ERR_CLIPDECK_TEST_OFFLINE'));
    assert.equal(receipt.childLaunches.length, 1);
    assert.equal(receipt.childLaunches[0].allowed, false);
    assert.equal(hits, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});


test('promisified exact bundled execFile preserves stdout/stderr, child and ESM exports while rejecting shells and other executables', async () => {
  const resources = await mkdtemp(path.join(os.tmpdir(), 'clipdeck-guard-'));
  try {
    const bin = path.join(resources,'runtime/bin');await mkdir(bin,{recursive:true});
    for (const name of ['ffprobe','ffmpeg']) {
      await writeFile(path.join(bin,name),'#!/bin/sh\nprintf "%s\\n" "$CLIPDECK_GUARD_TEST_VALUE:$1"\nprintf "diagnostic\\n" >&2\nexit "$2"\n',{mode:0o755});
    }
    const program = `
      import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {readFileSync} from 'node:fs';
      process.resourcesPath=process.argv[2];eval(readFileSync(process.argv[1],'utf8'));
      const run=promisify(execFile), file=process.resourcesPath+'/runtime/bin/ffprobe';
      const options={encoding:'utf8',maxBuffer:1024,env:{PATH:'/usr/bin:/bin',CLIPDECK_GUARD_TEST_VALUE:'retained'}};
      const promise=run(file,['argument with spaces','0'],options);const childPid=promise.child.pid;const result=await promise;
      let failed;const errorPromise=run(process.resourcesPath+'/runtime/bin/ffmpeg',['failed','7'],options);const errorPid=errorPromise.child.pid;
      try{await errorPromise}catch(error){failed={code:error.code,stdout:error.stdout,stderr:error.stderr}}
      const rejected={};async function deny(name,fn){try{await fn();rejected[name]='ALLOWED'}catch(error){rejected[name]=error.code}}
      await deny('shell-array-options',()=>run(file,['unused','0'],{shell:true}));
      await deny('shell-options-overload',()=>run(file,{shell:'/bin/sh'}));
      await deny('spawn-shell-options',()=>process.getBuiltinModule('node:child_process').spawn(file,[],{shell:true}));
      await deny('spawn-shell-overload',()=>process.getBuiltinModule('node:child_process').spawn(file,{shell:true}));
      await deny('unaccounted-execFile',()=>run(process.execPath,['-e','process.exit(0)']));
      await deny('shell-exec',()=>process.getBuiltinModule('node:child_process').exec('printf bypass'));
      console.log(JSON.stringify({result,childPid,errorPid,failed,rejected,trace:globalThis.__clipdeckOfflineProbe}));`;
    const result = await run(process.execPath,['--input-type=module','-e',program,guard,resources]);
    const proof=JSON.parse(result.stdout);
    assert.deepEqual(proof.result,{stdout:'retained:argument with spaces\n',stderr:'diagnostic\n'});
    assert.ok(proof.childPid>0 && proof.errorPid>0);
    assert.deepEqual(proof.failed,{code:7,stdout:'retained:failed\n',stderr:'diagnostic\n'});
    assert.ok(Object.values(proof.rejected).every(code=>code==='ERR_CLIPDECK_TEST_OFFLINE'));
    assert.equal(proof.trace.childLaunches.filter(row=>row.allowed).length,2);
    assert.deepEqual(proof.trace.childLaunches[0].args,['argument with spaces','0']);
    assert.equal(proof.trace.childLaunches[0].env.PATH,'/usr/bin:/bin');
    assert.equal(proof.trace.childLaunches[0].api,'execFile');
  } finally {await rm(resources,{recursive:true,force:true});}
});
