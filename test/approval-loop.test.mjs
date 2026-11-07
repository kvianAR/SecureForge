import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LiveRun, MAX_APPROVAL_CALLS_PER_RUN } from '../src/live-run.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-approval-loop-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, 'sample.py'), 'original\n');
  return root;
}

function mockClient(makeTurn) {
  const requests = [];
  let cancelled = 0;
  let deleted = 0;
  const client = {
    settings: { mcpServers: {
      create: async () => {},
      delete: async () => { deleted++; },
    } },
    sessions: {
      create: async () => ({ data: { id: 'test-session' } }),
      cancel: async () => { cancelled++; },
      createTurnStream: async (_session, req) => {
        const turn = requests.length;
        requests.push(req.input);
        const data = makeTurn(turn);
        return {
          async *withMetadata() {
            for (const event of data) yield { data: event };
          },
        };
      },
    },
  };
  return { client, requests, cancelled: () => cancelled, deleted: () => deleted };
}

function pending(id, toolName = 'propose_patch_batch', source = 'source-event') {
  return [
    { type: 'model.message', id: source, toolCalls: [
      { id, toolInfo: { name: toolName, type: 'mcp' }, function: { arguments: '{"private":"should-never-log"}' } },
    ] },
    { type: 'tool.approval_required', threadId: 'main',
      toolCalls: [{ id, sourceEventId: source }] },
    { type: 'turn.done', state: { status: 'done' } },
  ];
}

test('approval UI receives the verified tool name, count and exact call; source files stay untouched', async t => {
  const root = await fixture(t);
  const { client, requests, cancelled, deleted } = mockClient(index =>
    index === 0 ? pending('call-01') : [{ type: 'turn.done', state: { status: 'done' } }]);
  const shown = [];
  const run = new LiveRun({ client, root, approveTool: async info => {
    shown.push(info);
    return true;
  } });
  const result = await run.run({ model: 'test/model', task: 'Make a patch' });
  assert.equal(result.proposals.length, 0);
  assert.deepEqual(shown, [{
    sessionId: 'test-session', toolCallId: 'call-01', toolName: 'propose_patch_batch',
    index: 1, limit: MAX_APPROVAL_CALLS_PER_RUN,
  }]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], [{
    type: 'user.tool_approval', threadId: 'main', toolCallId: 'call-01',
    approval: { status: 'allow' },
  }]);
  assert.equal(run.getDiagnostics().approvalPrompts, 1);
  assert.equal(run.getDiagnostics().approvalTools.propose_patch_batch, 1);
  assert.equal(cancelled(), 0);
  assert.equal(deleted(), 1);
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'original\n');
});

test('repeated pending approval for the same call fails closed before showing a second dialog', async t => {
  const root = await fixture(t);
  const { client, requests, cancelled } = mockClient(() => pending('repeating-call'));
  const shown = [];
  const run = new LiveRun({ client, root, approveTool: async info => {
    shown.push(info.toolName);
    return true;
  } });
  await assert.rejects(run.run({ model: 'test/model', task: 'Task B' }), error => {
    assert.equal(error.code, 'approval_loop');
    assert.match(error.message, /repeated the same pending tool approval/);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.deepEqual(shown, ['propose_patch_batch']);
  assert.equal(requests.length, 2);
  assert.equal(run.getDiagnostics().approvalPrompts, 1);
  assert.equal(cancelled(), 1);
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'original\n');
});

test('distinct repeated tool approvals are capped; no silent automatic grant', async t => {
  const root = await fixture(t);
  const { client, requests, cancelled } = mockClient(index =>
    pending('call-' + index, 'propose_edit', 'source-' + index));
  let shown = 0;
  const run = new LiveRun({ client, root, approveTool: async () => {
    shown++;
    return true;
  } });
  await assert.rejects(run.run({ model: 'test/model', task: 'Task B' }), error => {
    assert.equal(error.code, 'approval_limit');
    assert.match(error.message, /more than 8 tool approvals/);
    return true;
  });
  assert.equal(shown, MAX_APPROVAL_CALLS_PER_RUN);
  assert.equal(requests.length, MAX_APPROVAL_CALLS_PER_RUN + 1);
  assert.equal(run.getDiagnostics().approvalPrompts, MAX_APPROVAL_CALLS_PER_RUN);
  assert.equal(cancelled(), 1);
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'original\n');
});

test('unidentified approval is labelled rather than guessed, and an explicit denial is preserved', async t => {
  const root = await fixture(t);
  const { client, requests } = mockClient(index => index === 0
    ? [
        { type: 'tool.approval_required', threadId: 'main', toolCalls: [{ id: 'unknown', sourceEventId: 'missing' }] },
        { type: 'turn.done', state: { status: 'done' } },
      ]
    : [{ type: 'turn.done', state: { status: 'done' } }]);
  const shown = [];
  const run = new LiveRun({ client, root, approveTool: async info => {
    shown.push(info.toolName);
    return false;
  } });
  const result = await run.run({ model: 'test/model', task: 'Inspect' });
  assert.deepEqual(shown, ['unidentified_tool']);
  assert.equal(result.proposals.length, 0);
  assert.equal(requests[1][0].approval.status, 'deny');
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'original\n');
});

test('malformed approval refs fail closed without a prompt or source write', async t => {
  const root = await fixture(t);
  const { client } = mockClient(() => [
    { type: 'tool.approval_required', threadId: '', toolCalls: [{ id: 'unknown' }] },
    { type: 'turn.done', state: { status: 'done' } },
  ]);
  const run = new LiveRun({ client, root, approveTool: async () => {
    assert.fail('Malformed approval should never be offered to the user');
  } });
  await assert.rejects(run.run({ model: 'test/model', task: 'Inspect' }), error => {
    assert.equal(error.code, 'approval_format');
    return true;
  });
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'original\n');
});

test('null pending approval calls retain the explicit malformed-approval diagnostic', async t => {
  const root = await fixture(t);
  const { client } = mockClient(() => [
    { type: 'tool.approval_required', threadId: 'main', toolCalls: [null] },
    { type: 'turn.done', state: { status: 'done' } },
  ]);
  const run = new LiveRun({ client, root, approveTool: async () => {
    assert.fail('Malformed approval must not reach the user');
  } });
  await assert.rejects(run.run({ model: 'test/model', task: 'Inspect' }), error => {
    assert.equal(error.code, 'approval_format');
    return true;
  });
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'original\n');
});
