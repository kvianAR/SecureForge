import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.mjs';
import { prepareCommand, runApprovedCommand } from '../src/commands.mjs';
import { createMcpServer } from '../src/mcp-server.mjs';

async function fixture(t, source = "console.log('verification ran');") {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-command-'));
  const workspace = await new Workspace(root).init();
  await writeFile(path.join(root, 'sample.test.mjs'), source);
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); });
  return { workspace, request: { executable: 'node', args: ['--test', 'sample.test.mjs'] } };
}

test('verification requires approval and records the actual approved command outcome', async t => {
  const options = await fixture(t);
  const denied = await runApprovedCommand({ ...options, approve: async () => false });
  assert.equal(denied.executed, false);
  const receipt = await runApprovedCommand({ ...options, approve: async command => {
    assert.equal(command.cwd, options.workspace.root);
    assert.equal(command.sources.length, 1);
    return true;
  } });
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.exitCode, 0);
  assert.match(receipt.output, /verification ran/);
});

test('shells, option injection, traversal, unknown commands and changed tests are denied', async t => {
  const options = await fixture(t);
  for (const request of [
    { executable: 'sh', args: ['-c', 'anything'] },
    { executable: 'node', args: ['--eval', 'anything'] },
    { executable: 'node', args: ['--test', '--require=evil.test.mjs'] },
    { executable: 'node', args: ['--test', '../outside.test.mjs'] },
    { executable: 'python3', args: ['-m', 'pytest', '--override-ini=test_bad.py'] },
  ]) await assert.rejects(prepareCommand(options.workspace, request));
  await assert.rejects(runApprovedCommand({ ...options, approve: async () => {
    await writeFile(path.join(options.workspace.root, 'sample.test.mjs'), 'changed');
    return true;
  } }), /changed after approval/);
});

test('verification rejects backslash selectors before approving a differently hashed file', async t => {
  const { workspace } = await fixture(t);
  await mkdir(path.join(workspace.root, 'dir', 'nested'), { recursive: true });
  await writeFile(path.join(workspace.root, 'dir', 'sample.test.mjs'), 'export {};');
  await writeFile(path.join(workspace.root, 'dir\\sample.test.mjs'), 'throw new Error("wrong file");');
  await writeFile(path.join(workspace.root, 'dir', 'nested', 'test_binding.py'), 'pass\n');
  let approvals = 0;
  for (const request of [
    { executable: 'node', args: ['--test', 'dir\\sample.test.mjs'] },
    { executable: 'python3', args: ['-m', 'pytest', 'dir\\nested/test_binding.py'] },
  ]) {
    await assert.rejects(runApprovedCommand({ workspace, request, approve: async () => {
      approvals++;
      return true;
    } }), /Only reviewed/);
  }
  assert.equal(approvals, 0);
});

test('verification bounds output, redacts credentials and omits provider environment', async t => {
  const options = await fixture(t, `
console.log('password=example-private-value');
console.log('provider=' + String(process.env.SECUREFORGE_TEST_CREDENTIAL));
console.log('x'.repeat(100000));
`);
  process.env.SECUREFORGE_TEST_CREDENTIAL = 'private-provider-value';
  t.after(() => delete process.env.SECUREFORGE_TEST_CREDENTIAL);
  const receipt = await runApprovedCommand({ ...options, approve: async () => true });
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.truncated, true);
  assert.ok(Buffer.byteLength(receipt.output) <= 64 * 1024);
  assert.ok(!receipt.output.includes('example-private-value'));
  assert.ok(!receipt.output.includes('private-provider-value'));
});

test('verification timeout and cancellation stop a running test process', async t => {
  const options = await fixture(t, 'setInterval(() => {}, 1000);');
  const timeout = await runApprovedCommand({ ...options,
    request: { ...options.request, timeoutMs: 150 }, approve: async () => true });
  assert.equal(timeout.status, 'timed_out');
  const controller = new AbortController();
  const run = runApprovedCommand({ ...options, signal: controller.signal, approve: async () => {
    setTimeout(() => controller.abort(), 150);
    return true;
  } });
  assert.equal((await run).status, 'cancelled');
});

test('MCP command capability is opt-in and still requires local approval', async t => {
  const options = await fixture(t);
  const bridge = await createMcpServer({ root: options.workspace.root, port: 0,
    onRunCommand: (workspace, request) => runApprovedCommand({ workspace, request, approve: async () => false }),
  });
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise(resolve => bridge.server.close(resolve));
    await bridge.workspace.close();
  });
  async function request(method, params) {
    const response = await fetch(`http://127.0.0.1:${bridge.address.port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await response.json()).result;
  }
  const tools = await request('tools/list');
  assert.equal(tools.tools.find(tool => tool.name === 'run_command').annotations.destructiveHint, true);
  const description = tools.tools.find(tool => tool.name === 'run_command').description;
  assert.match(description, /"executable":"python3"/);
  assert.match(description, /"args":\["-m","pytest"/);
  assert.match(description, /separately approved/);
  const result = await request('tools/call', { name: 'run_command', arguments: options.request });
  const receipt = JSON.parse(result.content[0].text);
  assert.equal(receipt.executed, false);
  assert.equal(receipt.status, 'denied');
});


test('verification preserves the selected executable symlink path for virtual environments', async t => {
  const options = await fixture(t);
  const directory = path.join(options.workspace.root, 'bin');
  await mkdir(directory);
  await symlink(process.execPath, path.join(directory, 'node'));
  const originalPath = process.env.PATH;
  process.env.PATH = directory;
  try {
    const command = await prepareCommand(options.workspace, options.request);
    assert.equal(command.executable, path.join(directory, 'node'));
  } finally { process.env.PATH = originalPath; }
});

test('cancellation and timeout finish escalation after the command leader closes', { timeout: 20000 }, async t => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const stopped = pid => {
    try {
      process.kill(pid, 0);
      return execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z');
    } catch (error) { return error.code === 'ESRCH' || error.status === 1; }
  };
  for (const mode of ['cancelled', 'timed_out']) {
    const stdio = mode === 'timed_out' ? 'inherit' : 'ignore';
    const options = await fixture(t, `import { spawn } from 'node:child_process';
spawn(process.execPath, ['worker.mjs', 'child.pid'], { stdio: ${JSON.stringify(stdio)} });
setInterval(() => {}, 1000);
`);
    await writeFile(path.join(options.workspace.root, 'worker.mjs'), `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`);
    const controller = new AbortController();
    let pid;
    let terminated = false;
    t.after(() => {
      controller.abort();
      if (pid && !terminated) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    });
    const request = { ...options.request, timeoutMs: 5000 };
    const receipt = runApprovedCommand({ ...options, request, approve: async () => true, signal: controller.signal });
    const readyDeadline = Date.now() + 4000;
    while (!pid && Date.now() < readyDeadline) {
      try {
        const value = Number(await readFile(path.join(options.workspace.root, 'child.pid'), 'utf8'));
        if (Number.isInteger(value) && value > 1) pid = value;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!pid) await delay(20);
    }
    assert.ok(pid, 'Owned descendant installs its SIGTERM handler');
    if (mode === 'cancelled') controller.abort();
    assert.equal((await receipt).status, mode);
    const stopDeadline = Date.now() + 2000;
    while (!stopped(pid) && Date.now() < stopDeadline) await delay(20);
    terminated = stopped(pid);
    assert.equal(terminated, true, `${mode} must terminate the owned descendant`);
  }
});

test('pytest rejects option-shaped paths even when a matching repository file exists', async t => {
  const { workspace } = await fixture(t);
  await mkdir(path.join(workspace.root, '--confcutdir=tests'));
  await writeFile(path.join(workspace.root, '--confcutdir=tests', 'test_fixture.py'), 'assert True\n');
  await assert.rejects(prepareCommand(workspace, {
    executable: 'python3', args: ['-m', 'pytest', '--confcutdir=tests/test_fixture.py'],
  }), /Pytest verification requires explicit test files/);
});

test('pytest verification chooses the workspace virtual environment and still requires approval', async t => {
  const { workspace } = await fixture(t);
  await mkdir(path.join(workspace.root, '.venv', 'bin'), { recursive: true });
  const interpreter = path.join(workspace.root, '.venv', 'bin', 'python');
  await symlink(process.execPath, interpreter);
  await writeFile(path.join(workspace.root, 'test_sample.py'), 'def test_ok(): assert True\n');
  const request = { executable: 'python3', args: ['-m', 'pytest', 'test_sample.py', '-q'] };
  const prepared = await prepareCommand(workspace, request);
  assert.equal(prepared.executable, interpreter);
  const receipt = await runApprovedCommand({ workspace, request, approve: async command => {
    assert.equal(command.executable, interpreter);
    return false;
  } });
  assert.equal(receipt.status, 'denied');
  assert.equal(receipt.executed, false);
});

test('pytest verification fails visibly for a broken project virtual environment', async t => {
  const { workspace } = await fixture(t);
  await mkdir(path.join(workspace.root, '.venv', 'bin'), { recursive: true });
  await writeFile(path.join(workspace.root, 'test_sample.py'), 'def test_ok(): assert True\n');
  await assert.rejects(prepareCommand(workspace, {
    executable: 'python3', args: ['-m', 'pytest', 'test_sample.py', '-q'],
  }), /virtual|interpreter|Workspace \.venv/i);
});

test('approved pytest pins PYTHONPATH to the selected workspace src, never the ambient environment', async t => {
  const { workspace } = await fixture(t);
  await mkdir(path.join(workspace.root, '.venv', 'bin'), { recursive: true });
  await mkdir(path.join(workspace.root, 'src'));
  await mkdir(path.join(workspace.root, 'tests'));
  const fakePython = path.join(workspace.root, '.venv', 'bin', 'python');
  await writeFile(fakePython,
    '#!' + process.execPath + '\nconsole.log("PYTHONPATH=" + String(process.env.PYTHONPATH));\n', { mode: 0o755 });
  await writeFile(path.join(workspace.root, 'tests', 'test_local.py'), 'def test_local(): pass\n');
  const old = process.env.PYTHONPATH;
  process.env.PYTHONPATH = '/untrusted/ambient/pythonpath';
  t.after(() => { if (old === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = old; });
  const request = { executable: 'python3', args: ['-m', 'pytest', 'tests/test_local.py', '-q'] };
  let approved = false;
  const receipt = await runApprovedCommand({ workspace, request, approve: async command => {
    approved = true;
    assert.equal(command.pythonSourcePath, path.join(workspace.root, 'src'));
    assert.equal(command.executable, fakePython);
    return true;
  } });
  assert.equal(approved, true);
  assert.equal(receipt.executed, true);
  assert.equal(receipt.status, 'passed');
  assert.ok(receipt.output.includes('PYTHONPATH=' + path.join(workspace.root, 'src')));
  assert.ok(!receipt.output.includes('/untrusted/ambient/pythonpath'));
});

test('pytest refuses symlinked src directories and never trusts an ambient PYTHONPATH', async t => {
  const { workspace } = await fixture(t);
  await mkdir(path.join(workspace.root, '.venv', 'bin'), { recursive: true });
  await symlink(process.execPath, path.join(workspace.root, '.venv', 'bin', 'python'));
  await mkdir(path.join(workspace.root, 'outside'));
  await symlink(path.join(workspace.root, 'outside'), path.join(workspace.root, 'src'));
  await writeFile(path.join(workspace.root, 'test_local.py'), 'def test_local(): pass\n');
  await assert.rejects(prepareCommand(workspace, {
    executable: 'python3', args: ['-m', 'pytest', 'test_local.py', '-q'],
  }), /Python source directory must be a real directory/);
});
