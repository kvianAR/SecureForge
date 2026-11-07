import { spawn } from 'node:child_process';
import { access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './workspace.mjs';

async function executablePath(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next executable directory. */ }
  }
  throw new Error(`Executable not found: ${name}`);
}


async function pytestExecutable(workspace) {
  // When Flask or another Python project has its own virtual environment,
  // use its interpreter instead of silently falling back to system Python.
  const venv = path.join(workspace.root, '.venv');
  let metadata;
  try { metadata = await lstat(venv); }
  catch (error) {
    if (error.code === 'ENOENT') return executablePath('python3');
    throw error;
  }
  if (!metadata.isDirectory()) throw new Error('Workspace .venv must be a real directory');
  const interpreter = process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  try { await access(interpreter, constants.X_OK); }
  catch { throw new Error('Workspace .venv exists but its Python interpreter is unavailable'); }
  return interpreter;
}

async function localPythonSourcePath(workspace) {
  // Python src-layout projects may not be editable-installed into the selected
  // venv. Pin PYTHONPATH to this workspace only, never to the user's ambient
  // PYTHONPATH, so pytest exercises the reviewed local source.
  const directory = path.join(workspace.root, 'src');
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory()) throw new Error('Python source directory must be a real directory');
    return directory;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function prepareCommand(workspace, request) {
  if (!request || !['node', 'python3'].includes(request.executable) || !Array.isArray(request.args) ||
      request.args.some(arg => typeof arg !== 'string' || arg.length > 500 || arg.includes('\\'))) {
    throw new Error('Only reviewed node --test or python3 -m pytest commands are supported');
  }
  const args = [...request.args];
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 120000)) {
    throw new Error('Command timeout must be an integer between 100 and 120000 ms');
  }
  let files;
  if (request.executable === 'node' && args[0] === '--test') {
    files = args.slice(1);
    if (!files.length || files.some(file => file.startsWith('-') || !/\.(?:test|spec)\.(?:mjs|cjs|js)$/.test(file))) {
      throw new Error('Node verification requires explicit test files');
    }
    args.splice(1, 0, '--test-reporter=tap');
  } else if (request.executable === 'python3' && args[0] === '-m' && args[1] === 'pytest') {
    files = args.slice(2).filter(arg => !['-q', '-x', '--disable-warnings'].includes(arg));
    if (!files.length || files.some(file => file.startsWith('-') || !/(?:^|\/)test_[\w.-]+\.py$/.test(file))) {
      throw new Error('Pytest verification requires explicit test files and supported flags');
    }
  } else {
    throw new Error('Unsupported verification command');
  }
  if (files.length > 20 || args.length > 25) throw new Error('Too many verification arguments');
  const sources = [];
  for (const file of files) {
    const source = await workspace.rawForProposal(file);
    sources.push({ path: source.relative, sha256: source.hash });
  }
  if (request.evidencePaths && (!Array.isArray(request.evidencePaths) || request.evidencePaths.length > 8)) {
    throw new Error('At most eight evidence paths are allowed');
  }
  const targets = [];
  for (const file of request.evidencePaths ?? []) {
    const source = await workspace.rawForProposal(file);
    targets.push({ path: source.relative, sha256: source.hash });
  }
  return Object.freeze({
    executable: request.executable === 'python3'
      ? await pytestExecutable(workspace) : await executablePath(request.executable),
    args: Object.freeze(args), cwd: workspace.root,
    pythonSourcePath: request.executable === 'python3' ? await localPythonSourcePath(workspace) : undefined,
    sources: Object.freeze(sources.map(source => Object.freeze(source))),
    targets: Object.freeze(targets.map(source => Object.freeze(source))),
    timeoutMs: Math.min(Math.max(request.timeoutMs ?? 30000, 100), 120000),
  });
}

export async function runApprovedCommand({ workspace, request, approve, signal }) {
  signal?.throwIfAborted();
  const command = await prepareCommand(workspace, request);
  if (!Number.isFinite(command.timeoutMs)) throw new Error('Invalid command timeout');
  if (await approve(command) !== true) {
    return { id: randomUUID(), status: 'denied', command, executed: false, output: '' };
  }
  signal?.throwIfAborted();
  for (const source of [...command.sources, ...command.targets]) {
    if ((await workspace.rawForProposal(source.path)).hash !== source.sha256) {
      throw new Error('Verification test changed after approval');
    }
  }
  signal?.throwIfAborted();
  const started = Date.now();
  const environment = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  if (command.pythonSourcePath) environment.PYTHONPATH = command.pythonSourcePath;
  return new Promise(resolve => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd, env: environment, shell: false, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let byteCount = 0;
    let truncated = false;
    let reason;
    let killTimer;
    let closed;
    let escalationDone = false;
    function terminate(status) {
      if (reason) return;
      reason = status;
      const kill = signalName => {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signalName); }
        catch { /* The process may already have exited. */ }
      };
      kill('SIGTERM');
      killTimer = setTimeout(() => {
        kill('SIGKILL');
        // Descendants can retain pipe handles after the leader exits.
        child.stdout?.destroy();
        child.stderr?.destroy();
        escalationDone = true;
        finish();
      }, 500);
    }
    function capture(chunk) {
      const remaining = Math.max(0, 64 * 1024 - byteCount);
      if (chunk.length > remaining) truncated = true;
      if (remaining) chunks.push(chunk.subarray(0, remaining));
      byteCount += Math.min(chunk.length, remaining);
    }
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timeout = setTimeout(() => terminate('timed_out'), command.timeoutMs);
    const abort = () => terminate('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let spawnError;
    child.on('error', error => { spawnError = error.code || 'SPAWN_ERROR'; });
    child.on('close', (exitCode, exitSignal) => {
      closed = { exitCode, exitSignal };
      finish();
    });
    function finish() {
      if (!closed || (reason && !escalationDone)) return;
      const { exitCode, exitSignal } = closed;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      const masked = redactSecrets(Buffer.concat(chunks).toString('utf8'));
      const encoded = Buffer.from(masked);
      const output = encoded.length <= 64 * 1024 ? masked : encoded.subarray(0, 64 * 1024 - 4).toString('utf8');
      resolve({
        id: randomUUID(), command, executed: !spawnError,
        status: reason || (spawnError ? 'error' : exitCode === 0 ? 'passed' : 'failed'),
        exitCode, signal: exitSignal, durationMs: Date.now() - started,
        output,
        truncated: truncated || encoded.length > 64 * 1024, ...(spawnError ? { error: spawnError } : {}),
      });
    }
  });
}
