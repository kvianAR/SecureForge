import test from 'node:test';
import assert from 'node:assert/strict';
import { createReview, composeAcceptedHunks } from '../src/review.mjs';
import { sha256 } from '../src/workspace.mjs';
import { applyReview, undoReviewGroup } from '../extension/apply-review.mjs';

function proposal(originalContent, proposedContent, extra = {}) {
  return {
    schemaVersion: 1, status: 'pending', id: 'test-proposal', path: 'sample.py', rationale: 'Review sample',
    originalContent, proposedContent,
    baseSha256: sha256(originalContent), proposedSha256: sha256(proposedContent), ...extra,
  };
}

function decide(review, decision) {
  return Object.fromEntries(review.hunks.map(hunk => [hunk.id, decision]));
}

test('mixed decisions change only the accepted hunk and preserve unchanged lines', () => {
  const original = 'first\nunchanged\nlast\n';
  const review = createReview(proposal(original, 'FIRST\nunchanged\nLAST\n'));
  assert.equal(review.hunks.length, 2);
  const decisions = { [review.hunks[0].id]: 'accept', [review.hunks[1].id]: 'reject' };
  const result = composeAcceptedHunks(review, decisions, original);
  assert.equal(result.content, 'FIRST\nunchanged\nlast\n');
  assert.equal(result.accepted.length, 1);
  assert.equal(composeAcceptedHunks(review, decide(review, 'reject'), original).content, original);
});

test('accepted hunks reproduce insertions, deletions, Unicode, CRLF and final-newline changes exactly', () => {
  const cases = [
    ['', 'hello\n'], ['hello\n', ''], ['a\nb\n', 'before\na\nb\nafter\n'],
    ['a\nb\nc\n', 'a\nc\n'], ['hello', 'hello\n'], ['hello\n', 'hello'],
    ['a\r\nb\r\n', 'A\r\nb\r\n'], ['😀 café\nkeep\n', '😀 नमस्ते\nkeep\n'],
    ['a\nb', 'a\nb\nnew'], ['a\nb\nc', 'A\nb\nC'],
  ];
  for (const [original, proposed] of cases) {
    const review = createReview(proposal(original, proposed));
    assert.equal(composeAcceptedHunks(review, decide(review, 'accept'), original).content, proposed);
    assert.equal(composeAcceptedHunks(review, decide(review, 'reject'), original).content, original);
  }
});

test('reviews reject tampered hashes, credential content, empty changes and oversized proposals', () => {
  assert.throws(() => createReview(proposal('old', 'new', { baseSha256: '0'.repeat(64) })), /SHA-256/);
  assert.throws(() => createReview(proposal('old', 'new', { proposedSha256: '0'.repeat(64) })), /SHA-256/);
  assert.throws(() => createReview(proposal('old', 'password = "example-secret"')), /credentials/);
  assert.throws(() => createReview(proposal('same', 'same')), /no changes/);
  assert.throws(() => createReview(proposal('old', 'x'.repeat(256 * 1024 + 1))), /bounded/);
  assert.throws(() => createReview(proposal('old', 'new', { status: 'applied' })), /pending/);
});

test('review accepts the same exact proposed test sentinels as staging while protecting original source', () => {
  for (const value of ['0', 'None', 'null', 'True', 'False', '"***"', '"[REDACTED]"']) {
    const proposed = `payload = {"password": ${value}}\n`;
    const review = createReview(proposal('old\n', proposed));
    assert.equal(composeAcceptedHunks(review, decide(review, 'accept'), 'old\n').content, proposed);
  }
  assert.throws(() => createReview(proposal('password = "***"\n', 'new\n')), /credentials/);
  assert.throws(() => createReview(proposal('old\n', 'password = "0" "not-a-test-sentinel"\n')), /credentials/);
});

test('stale, missing and forged hunk decisions cannot apply', () => {
  const review = createReview(proposal('old', 'new'));
  assert.throws(() => composeAcceptedHunks(review, decide(review, 'accept'), 'edited'), /Stale/);
  assert.throws(() => composeAcceptedHunks(review, {}, 'old'), /every hunk/);
  assert.throws(() => composeAcceptedHunks(review, { forged: 'accept' }, 'old'), /Invalid/);
  assert.throws(() => composeAcceptedHunks(review, { [review.hunks[0].id]: 'maybe' }, 'old'), /Invalid/);
  assert.ok(Object.isFrozen(review.hunks[0]));
});

test('excessive hunk counts cannot flood the editor review panel', () => {
  const original = Array.from({ length: 201 }, (_, i) => `old ${i}\nkeep ${i}\n`).join('');
  const proposed = Array.from({ length: 201 }, (_, i) => `new ${i}\nkeep ${i}\n`).join('');
  // Under load, the bounded diff timeout can reject the proposal before hunk counting.
  assert.throws(() => createReview(proposal(original, proposed)), /200-hunk|review complexity limit/);
});

function applyFixture() {
  const review = createReview(proposal('first\nkeep\nlast\n', 'FIRST\nkeep\nLAST\n'));
  let writes = 0;
  const document = {
    isClosed: false, isDirty: false, version: 1,
    uri: { scheme: 'file', fsPath: '/project/sample.py' },
    getText: () => review.originalContent,
    positionAt: value => value,
  };
  const workspace = {
    root: '/project',
    rawForProposal: async () => ({ hash: review.baseSha256 }),
  };
  const vscode = {
    workspace: { isTrusted: true, applyEdit: async () => { writes++; return false; } },
    WorkspaceEdit: class { replace() {} },
    Range: class {},
  };
  return { review, document, workspace, vscode, baseVersion: 1,
    decisions: decide(review, 'accept'), writes: () => writes };
}

test('apply rejects version changes even when text was restored to the original', async () => {
  const fixture = applyFixture();
  fixture.document.version = 3;
  await assert.rejects(applyReview(fixture), /Stale/);
  assert.equal(fixture.writes(), 0);
});

test('apply detects editor changes made during asynchronous disk validation', async () => {
  const fixture = applyFixture();
  fixture.workspace.rawForProposal = async () => {
    fixture.document.version++;
    return { hash: fixture.review.baseSha256 };
  };
  await assert.rejects(applyReview(fixture), /Stale/);
  assert.equal(fixture.writes(), 0);
});

test('apply blocks changed disk content, wrong document, untrusted workspace and dirty buffers', async () => {
  for (const mutate of [
    fixture => { fixture.workspace.rawForProposal = async () => ({ hash: sha256('changed') }); },
    fixture => { fixture.document.uri.fsPath = '/other/sample.py'; },
    fixture => { fixture.vscode.workspace.isTrusted = false; },
    fixture => { fixture.document.isDirty = true; },
  ]) {
    const fixture = applyFixture();
    mutate(fixture);
    await assert.rejects(applyReview(fixture));
    assert.equal(fixture.writes(), 0);
  }
});

test('all rejected hunks perform zero writes and failed WorkspaceEdit is surfaced', async () => {
  const fixture = applyFixture();
  fixture.decisions = decide(fixture.review, 'reject');
  assert.deepEqual(await applyReview(fixture), { status: 'rejected', accepted: 0 });
  assert.equal(fixture.writes(), 0);
  fixture.decisions = decide(fixture.review, 'accept');
  await assert.rejects(applyReview(fixture), /declined/);
});

test('guarded Undo cannot overwrite intervening document changes', async () => {
  const fixture = applyFixture();
  fixture.document.version = 2;
  await assert.rejects(undoReviewGroup({ ...fixture,
    entries: [{ document: fixture.document, review: fixture.review }],
    receipt: { status: 'applied', files: [{
      path: fixture.review.path, documentVersion: 1,
      beforeSha256: fixture.review.baseSha256, afterSha256: fixture.review.baseSha256,
      acceptedHunkIds: [fixture.review.hunks[0].id],
    }] },
  }), /Cannot undo/);
  assert.equal(fixture.writes(), 0);
});
