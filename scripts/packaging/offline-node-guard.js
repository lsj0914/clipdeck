// Test instrumentation, injected while the packaged main entry is paused.
// API denial is not a kernel security boundary. Never activate this guard
// in the product main/preload; only the explicit external harness injects it.
(() => {
  const get = process.getBuiltinModule.bind(process);
  const attempts = [];
  const guard = { attempts, childLaunches: [], installedAt: Date.now(), mainModule: process.mainModule?.filename };
  globalThis.__clipdeckOfflineProbe = guard;
  function rejection(api) {
    attempts.push({ api, at: Date.now() });
    return Object.assign(new Error('Offline validation rejected ' + api), { code: 'ERR_CLIPDECK_TEST_OFFLINE' });
  }
  function block(object, key, api) { object[key] = function () { throw rejection(api); }; }
  for (const name of ['http', 'https']) for (const key of ['request', 'get']) block(get('node:' + name), key, name + '.' + key);
  for (const key of ['connect', 'createConnection']) block(get('node:net'), key, 'net.' + key);
  block(get('node:net').Socket.prototype, 'connect', 'net.Socket.connect');
  block(get('node:tls'), 'connect', 'tls.connect');
  for (const key of ['connect', 'send']) block(get('node:dgram').Socket.prototype, key, 'dgram.Socket.' + key);
  for (const key of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
    const dns = get('node:dns');
    if (typeof dns[key] === 'function') block(dns, key, 'dns.' + key);
    if (typeof dns.promises[key] === 'function') dns.promises[key] = async function () { throw rejection('dns.promises.' + key); };
    if (typeof dns.Resolver.prototype[key] === 'function') block(dns.Resolver.prototype, key, 'dns.Resolver.' + key);
    if (typeof dns.promises.Resolver.prototype[key] === 'function') block(dns.promises.Resolver.prototype, key, 'dns.promises.Resolver.' + key);
  }
  globalThis.fetch = async function () { throw rejection('global.fetch'); };
  globalThis.WebSocket = class { constructor() { throw rejection('global.WebSocket'); } };
  // Fail on any new unaccounted native/network-capable child path. This leaves
  // the product's real bundled FFmpeg/ffprobe and OS-denied worker untouched.
  const child = get('node:child_process');
  const originalSpawn = child.spawn, originalExecFile = child.execFile;
  const resources = process.resourcesPath;
  const python = resources + '/runtime/worker/bin/python3.12';
  const worker = resources + '/worker/transcribe.py';
  function callOptions(args, options) {
    // Preserve documented args/options/callback overloads; forwarding below
    // retains Node's own argument validation and actual execution semantics.
    if (args && typeof args === 'object' && !Array.isArray(args)) return args;
    return options && typeof options === 'object' ? options : {};
  }
  function account(api, executable, args, options) {
    const argv = Array.isArray(args) ? args : [];
    const opts = callOptions(args, options);
    const media = executable === resources + '/runtime/bin/ffmpeg' || executable === resources + '/runtime/bin/ffprobe';
    const deniedWorker = api === 'spawn' && executable === '/usr/bin/sandbox-exec' && argv.length === 4 && argv[0] === '-p' && argv[1] === '(version 1)(allow default)(deny network-outbound)' && argv[2] === python && argv[3] === worker;
    const shell = opts.shell !== undefined && opts.shell !== false;
    const effectiveEnv = opts.env ?? process.env;
    const env = Object.fromEntries(['PATH','HF_HOME','HF_HUB_OFFLINE','TRANSFORMERS_OFFLINE','ORT_DISABLE_TELEMETRY','PYTHONDONTWRITEBYTECODE'].filter(key=>effectiveEnv[key]!==undefined).map(key=>[key,effectiveEnv[key]]));
    const allowed = !shell && (media || deniedWorker);
    guard.childLaunches.push({ api, executable, args: [...argv], env, shell, allowed });
    if (!allowed) throw rejection('unexpected child_process.' + api);
  }
  child.spawn = function spawn(executable, args, options) {
    account('spawn', executable, args, options);
    return Reflect.apply(originalSpawn, this, arguments);
  };
  child.execFile = function execFile(executable, args, options, callback) {
    account('execFile', executable, args, options);
    return Reflect.apply(originalExecFile, this, arguments);
  };
  // Copying the original custom promisifier would bypass the guarded wrapper:
  // Node's function closes over the original execFile. Recreate its documented
  // {stdout,stderr}/error.stdout/error.stderr and Promise.child behavior instead.
  const custom = get('node:util').promisify.custom;
  Object.defineProperty(child.execFile, custom, {
    value: function execFile(...args) {
      const {promise, resolve, reject} = Promise.withResolvers();
      promise.child = child.execFile(...args, (error, stdout, stderr) => {
        if (error !== null) { error.stdout = stdout; error.stderr = stderr; reject(error); }
        else resolve({stdout, stderr});
      });
      return promise;
    }, writable: false, enumerable: false, configurable: false,
  });
  for (const key of ['exec', 'fork', 'spawnSync', 'execSync', 'execFileSync']) block(child, key, 'child_process.' + key);
  get('node:worker_threads').Worker = class { constructor() { throw rejection('worker_threads.Worker'); } };
  get('node:module').syncBuiltinESMExports();
  return { installedAt: guard.installedAt, mainModule: guard.mainModule, code: 'ERR_CLIPDECK_TEST_OFFLINE' };
})()
