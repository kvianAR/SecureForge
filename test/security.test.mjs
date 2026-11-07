import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace, sha256 } from '../src/workspace.mjs';
import { inspectSecuritySource, reviewSecurity, prepareOwnedFixtureFix } from '../src/security.mjs';
import { createOwnedLab, assessFixProof } from '../src/proof.mjs';
import { runApprovedCommand } from '../src/commands.mjs';
import { createReview, composeAcceptedHunks } from '../src/review.mjs';
import { createPassport } from '../src/passport.mjs';

async function labFixture(t) {
  const lab = await createOwnedLab();
  const workspace = await new Workspace(lab.root).init();
  t.after(async () => { await workspace.close(); await rm(lab.root, { recursive: true, force: true }); });
  return { workspace, lab };
}

test('owned labs use fresh private OS temporary directories', async t => {
  const first = await createOwnedLab();
  t.after(() => rm(first.root, { recursive: true, force: true }));
  const second = await createOwnedLab();
  t.after(() => rm(second.root, { recursive: true, force: true }));
  assert.notEqual(first.root, second.root);
  for (const lab of [first, second]) {
    assert.equal(path.dirname(lab.root), os.tmpdir());
    assert.equal((await stat(lab.root)).mode & 0o777, 0o700);
    assert.equal(await readFile(path.join(lab.root, lab.targetPath), 'utf8'),
      await readFile(new URL('../fixtures/security-lab/vulnerable/storage.mjs', import.meta.url), 'utf8'));
  }
});

test('security review preserves sources, distinguishes the owned flaw and safe control, and reports limitations', async t => {
  const { workspace, lab } = await labFixture(t);
  const original = await workspace.rawForProposal(lab.targetPath);
  const report = await reviewSecurity(workspace, { paths: [lab.targetPath, 'safe/storage.mjs'] });
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.equal(finding.ruleId, 'SF-PATH-001');
  assert.equal(finding.path, lab.targetPath);
  assert.equal(finding.sourceSha256, original.hash);
  assert.equal(finding.status, 'candidate');
  assert.equal(finding.verification, 'not_run');
  assert.ok(finding.line > 0);
  assert.ok(report.limitations.length);
  const proposal = await prepareOwnedFixtureFix(workspace, finding);
  assert.equal((await workspace.rawForProposal(lab.targetPath)).hash, original.hash);
  assert.notEqual(proposal.proposedSha256, original.hash);
  await writeFile(path.join(workspace.root, lab.targetPath), original.raw + '\n');
  await assert.rejects(prepareOwnedFixtureFix(workspace, finding), /stale/);
});

test('static candidates cover command/query patterns without leaking credential values', () => {
  const raw = 'exec(`echo ${input}`);\ndb.execute(f"SELECT {value}");\nconst password = "example-secret";\n';
  const findings = inspectSecuritySource({ path: 'example.js', raw, hash: sha256(raw) });
  assert.deepEqual(findings.map(finding => finding.ruleId), ['SF-CMD-001', 'SF-SQL-001', 'SF-SECRET-001']);
  assert.ok(!JSON.stringify(findings).includes('example-secret'));
  assert.ok(findings.every(finding => finding.status === 'candidate'));
});

test('security scope reports denied files and cancellation does not create a report', async t => {
  const { workspace } = await labFixture(t);
  const report = await reviewSecurity(workspace, { paths: ['../outside.txt'] });
  assert.equal(report.sources.length, 0);
  assert.equal(report.skipped.length, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(reviewSecurity(workspace, { signal: controller.signal }));
});

test('owned regression fails before the reviewed fix, passes after it, and supports an evidence-linked passport', async t => {
  const { workspace, lab } = await labFixture(t);
  const report = await reviewSecurity(workspace, { paths: [lab.targetPath, 'safe/storage.mjs'] });
  const finding = report.findings[0];
  const request = { executable: 'node', args: ['--test', lab.testPath], evidencePaths: [lab.targetPath] };
  const before = await runApprovedCommand({ workspace, request, approve: async () => true });
  assert.equal(before.status, 'failed');
  assert.match(before.output, /not ok[^\n]*parent-directory/);
  const proposal = await prepareOwnedFixtureFix(workspace, finding);
  const review = createReview(proposal);
  const decisions = Object.fromEntries(review.hunks.map(hunk => [hunk.id, 'accept']));
  const accepted = composeAcceptedHunks(review, decisions, proposal.originalContent);
  // Test-only simulation of a human-accepted edit. Product writes use WorkspaceEdit.
  await writeFile(path.join(workspace.root, lab.targetPath), accepted.content);
  const after = await runApprovedCommand({ workspace, request, approve: async () => true });
  assert.equal(after.status, 'passed');
  const proof = assessFixProof({ before, after, beforeSha256: finding.sourceSha256,
    afterContent: accepted.content, finding, approvedProposalId: proposal.id });
  assert.equal(proof.status, 'verified_on_owned_fixture');
  assert.equal(assessFixProof({ before: after, after, beforeSha256: finding.sourceSha256,
    afterContent: accepted.content, finding, approvedProposalId: proposal.id }).status, 'inconclusive');
  const passport = createPassport({
    reviews: [{ group: { id: review.id, files: [review] }, decisions,
      result: { status: 'applied', files: [{ path: review.path, afterSha256: sha256(accepted.content) }] } }],
    receipts: [before, after], securityReports: [report], proofs: [proof],
  });
  const json = JSON.stringify(passport);
  assert.equal(passport.verification.length, 2);
  assert.equal(passport.proofs[0].beforeReceiptId, before.id);
  assert.ok(!json.includes('originalContent'));
  assert.ok(!json.includes('proposedContent'));
  assert.ok(passport.uncertainties.length > 0);
  assert.ok((await readFile(path.join(workspace.root, 'safe/storage.mjs'), 'utf8')).includes('allowedRoot'));
});

test('passport redaction preserves JSON syntax for quoted and multiline output', () => {
  const passport = createPassport({ receipts: [{ id: 'receipt', status: 'failed', executed: true,
    command: { executable: 'node', args: ['--test', 'example.test.mjs'] },
    output: 'password="example-private"\napi_key:\n  second-private',
  }] });
  const encoded = JSON.stringify(passport);
  assert.ok(!encoded.includes('example-private'));
  assert.ok(!encoded.includes('second-private'));
  assert.deepEqual(JSON.parse(encoded).verification[0].status, 'failed');
});

test('Python input traces include source, propagation and sink while respecting reset boundaries', () => {
  const raw = `def unsafe():
    value = request.args.get("name")
    query = "SELECT * FROM users WHERE name = " + value
    cursor.execute(query)
def parameterized():
    value = request.args.get("name")
    cursor.execute("SELECT * FROM users WHERE name = ?", (value,))
def overwritten():
    value = request.args.get("name")
    value = "constant"
    os.system(value)
def isolated():
    os.system(query)
def subprocess_safe():
    value = request.args.get("name")
    subprocess.run(["echo", value], shell=False)
`;
  const findings = inspectSecuritySource({ path: 'handler.py', raw, hash: sha256(raw) });
  const flows = findings.filter(item => item.ruleId === 'SF-FLOW-001');
  assert.equal(flows.length, 1);
  assert.deepEqual(flows[0].trace.map(step => step.line), [2, 3, 4]);
  assert.equal(flows[0].status, 'candidate');
  assert.equal(flows[0].sourceSha256, sha256(raw));
});
