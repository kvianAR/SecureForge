const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vscode = require('vscode');


exports.run = async function run() {
  const results = [];
  // Emit incremental evidence: a stuck editor host should never look like an
  // empty run. The launcher can inspect this partial report without VS Code.
  async function checkpoint(label) {
    results.push(label);
    console.log(`SecureForge editor check passed: ${label}`);
    if (process.env.SECUREFORGE_EDITOR_REPORT) {
      await fs.writeFile(process.env.SECUREFORGE_EDITOR_REPORT,
        JSON.stringify({ passed: results, lastCheckpoint: label, incomplete: true }, null, 2));
    }
  }
  console.log('SecureForge editor acceptance started');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'secureforge-editor-'));
  const { Workspace, sha256 } = await import('../../src/workspace.mjs');
  const { ProposalStore } = await import('../../src/proposals.mjs');
  const { createReview } = await import('../../src/review.mjs');
  const { applyReview, applyReviewGroup, undoReviewGroup } = await import('../../extension/apply-review.mjs');
  const { createReviewGroup } = await import('../../src/review-group.mjs');
  const { BatchProposalStore } = await import('../../src/build/batches.mjs');
  const workspace = await new Workspace(root).init();
  const original = 'first\nunchanged\nlast\n';
  const proposed = 'FIRST\nunchanged\nLAST\n';
  const filename = path.join(workspace.root, 'sample.py');
  try {
    const extension = vscode.extensions.getExtension('secureforge.secureforge-review');
    assert.ok(extension, 'Review extension is installed in the development host');
    const api = await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('secureforge.reviewProposal'));
    assert.ok(commands.includes('secureforge.reviewDemo'));
    for (const command of ['secureforge.openAgentPanel', 'secureforge.inlineEdit', 'secureforge.previewContext', 'secureforge.attachFile', 'secureforge.attachSymbol']) assert.ok(commands.includes(command));
    // SecureForge is a contributed WebviewView in the secondary sidebar.
    // Focusing a view returns no WebviewPanel object. Earlier tests expected
    // a separate editor panel, which is no longer part of the design.
    assert.ok(commands.includes('secureforge.agentSidebar.focus'), 'Sidebar view focus command is contributed');
    await vscode.commands.executeCommand('secureforge.openAgentPanel');
    await checkpoint('Extension activation, sidebar registration and focus command');

    await fs.writeFile(filename, original);
    const store = new ProposalStore(workspace);
    const summary = await store.proposeEdit({
      path: 'sample.py', expectedSha256: sha256(original), proposedContent: proposed,
    });
    const review = createReview(store.getProposal(summary.id));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filename));
    await vscode.window.showTextDocument(document);
    const baseVersion = document.version;
    const decisions = { [review.hunks[0].id]: 'accept', [review.hunks[1].id]: 'reject' };
    const inputs = { vscode, workspace, document, review, decisions, baseVersion };
    const singleEntries = [{ document, review, baseVersion }];
    const singleReceipt = await applyReviewGroup({ vscode, workspace, entries: singleEntries, decisions });
    assert.equal(singleReceipt.status, 'applied');
    assert.equal(document.getText(), 'FIRST\nunchanged\nlast\n');
    assert.equal(await fs.readFile(filename, 'utf8'), original);
    await checkpoint('Mixed hunk decisions apply only the accepted edit in the editor');

    await assert.rejects(applyReview(inputs), /Stale/);
    await checkpoint('Repeated application is rejected');
    await undoReviewGroup({ vscode, workspace, entries: singleEntries, receipt: singleReceipt });
    assert.equal(document.getText(), original);
    await checkpoint('Guarded review Undo restores the original content');
    await document.save();

    await assert.rejects(applyReview(inputs), /Stale/);
    await checkpoint('Changed document version is rejected even after Undo');
    const freshInputs = { ...inputs, baseVersion: document.version };
    freshInputs.decisions = Object.fromEntries(review.hunks.map(hunk => [hunk.id, 'reject']));
    assert.equal((await applyReview(freshInputs)).status, 'rejected');
    assert.equal(document.getText(), original);
    await checkpoint('Rejecting all hunks preserves content');

    await fs.writeFile(filename, 'external disk edit\n');
    await assert.rejects(applyReview(freshInputs), /Stale/);
    assert.equal(await fs.readFile(filename, 'utf8'), 'external disk edit\n');
    await checkpoint('External disk changes are preserved');

    const unicodeOriginal = '😀 café\r\nkeep\r\nlast';
    const unicodeProposed = '😀 नमस्ते\r\nkeep\r\nLAST';
    const unicodePath = path.join(workspace.root, 'unicode.py');
    await fs.writeFile(unicodePath, unicodeOriginal);
    const unicodeSummary = await store.proposeEdit({
      path: 'unicode.py', expectedSha256: sha256(unicodeOriginal), proposedContent: unicodeProposed,
    });
    const unicodeReview = createReview(store.getProposal(unicodeSummary.id));
    const unicodeDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(unicodePath));
    await vscode.window.showTextDocument(unicodeDocument);
    const unicodeEntries = [{ document: unicodeDocument, review: unicodeReview, baseVersion: unicodeDocument.version }];
    const unicodeReceipt = await applyReviewGroup({
      vscode, workspace, entries: unicodeEntries,
      decisions: Object.fromEntries(unicodeReview.hunks.map(hunk => [hunk.id, 'accept'])),
    });
    assert.equal(unicodeDocument.getText(), unicodeProposed);
    await undoReviewGroup({ vscode, workspace, entries: unicodeEntries, receipt: unicodeReceipt });
    assert.equal(unicodeDocument.getText(), unicodeOriginal);
    await checkpoint('Unicode, CRLF and missing final newline survive editor apply and Undo');

    await fs.writeFile(path.join(workspace.root, 'first.py'), original);
    await fs.writeFile(path.join(workspace.root, 'second.py'), original);
    const batches = new BatchProposalStore(store);
    const batch = await batches.proposeBatch({ edits: ['first.py', 'second.py'].map(file => ({
      path: file, expectedSha256: sha256(original), proposedContent: proposed,
    })) });
    const group = createReviewGroup({ ...batch, proposals: batch.proposals.map(item => store.getProposal(item.id)) });
    const entries = [];
    for (const file of group.files) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace.root, file.path)));
      entries.push({ document, review: file, baseVersion: document.version });
    }
    const groupDecisions = Object.fromEntries(group.files.flatMap(file => file.hunks.map(hunk => [hunk.id, 'accept'])));
    const groupInput = { vscode, workspace, entries, decisions: groupDecisions };
    const groupReceipt = await applyReviewGroup(groupInput);
    assert.equal(groupReceipt.accepted, 4);
    assert.equal(entries[0].document.getText(), proposed);
    assert.equal(entries[1].document.getText(), proposed);
    await undoReviewGroup({ ...groupInput, receipt: groupReceipt });
    assert.equal(entries[1].document.getText(), original);
    await checkpoint('One WorkspaceEdit applies a batch and one guarded Undo reverses both files');
    for (const entry of entries) {
      await entry.document.save();
      entry.baseVersion = entry.document.version;
    }
    await fs.writeFile(path.join(workspace.root, 'second.py'), 'external edit\n');
    await assert.rejects(applyReviewGroup(groupInput), /Stale/);
    assert.equal(entries[0].document.getText(), original);
    await checkpoint('A stale member blocks the entire multi-file apply');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(applyReviewGroup({ ...groupInput, signal: controller.signal }));
    assert.equal(entries[0].document.getText(), original);
    await checkpoint('Cancellation before batch apply preserves all documents');
    const { createOwnedLab, assessFixProof } = await import('../../src/proof.mjs');
    const { reviewSecurity, prepareOwnedFixtureFix } = await import('../../src/security.mjs');
    const { runApprovedCommand } = await import('../../src/commands.mjs');
    const { createPassport } = await import('../../src/passport.mjs');
    const lab = await createOwnedLab();
    const labWorkspace = await new Workspace(lab.root).init();
    try {
      const report = await reviewSecurity(labWorkspace, { paths: [lab.targetPath, 'safe/storage.mjs'] });
      assert.equal(report.findings.length, 1);
      const finding = report.findings[0];
      const request = { executable: 'node', args: ['--test', lab.testPath], evidencePaths: [lab.targetPath] };
      const before = await runApprovedCommand({ workspace: labWorkspace, request, approve: async () => true });
      assert.equal(before.status, 'failed');
      const proposal = await prepareOwnedFixtureFix(labWorkspace, finding);
      const review = createReview(proposal);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(labWorkspace.root, lab.targetPath)));
      const entries = [{ document, review, baseVersion: document.version }];
      const decisions = Object.fromEntries(review.hunks.map(hunk => [hunk.id, 'accept']));
      const result = await applyReviewGroup({ vscode, workspace: labWorkspace, entries, decisions });
      await document.save();
      const after = await runApprovedCommand({ workspace: labWorkspace, request, approve: async () => true });
      const proof = assessFixProof({ before, after, beforeSha256: finding.sourceSha256,
        afterContent: document.getText(), finding, approvedProposalId: proposal.id });
      assert.equal(proof.status, 'verified_on_owned_fixture');
      api.recordReview({ group: { id: review.id, files: [review] }, decisions, result });
      const passport = createPassport({ reviews: api.applied, receipts: [before, after], securityReports: [report], proofs: [proof] });
      assert.equal(passport.patches.at(-1).status, 'applied');
      assert.equal(passport.verification[1].status, 'passed');
      assert.equal(passport.proofs[0].status, 'verified_on_owned_fixture');
      assert.ok(!JSON.stringify(passport).includes('originalContent'));
      await checkpoint('Owned security finding, editor-reviewed fix, saved regression proof and Patch Passport agree');
    } finally { await labWorkspace.close(); await fs.rm(lab.root, { recursive: true, force: true }); }
    if (process.env.SECUREFORGE_EDITOR_FAILURE_REPORT) {
      await require('./failure-check.cjs').verifyEditorFailure(vscode, api);
      await checkpoint('Task C uses the exact Task A prompt, shows a clear failure, remains responsive and preserves pinned Flask sources');
    }
    if (process.env.SECUREFORGE_EDITOR_WIRE === '1') {
      const { verifyTrueForgeWire } = await import('./trueforge-wire.mjs');
      const { openReviewPayload } = await import('../../extension/review-ui.mjs');
      const { verifyBuildWorkflow } = await import('./workflow-check.mjs');
      const wire = await verifyTrueForgeWire({ onConfigured: verifyBuildWorkflow, onPayload: async (payload, root) => {
        const source = await new Workspace(root).init();
        const context = { subscriptions: [] };
        const panel = await openReviewPayload(vscode, context, source, payload);
        assert.ok(panel);
        assert.match(panel.webview.html, /Review proposed changes/);
        panel.dispose();
      } });
      if (process.env.SECUREFORGE_EDITOR_BUNDLE_REPORT) {
        await fs.writeFile(process.env.SECUREFORGE_EDITOR_BUNDLE_REPORT, JSON.stringify({ mode: 'deterministic inference fixture, real SDK/runtime/MCP', ...wire }, null, 2));
      }
      await checkpoint('Normal Build command delivers a real runtime proposal into review using fixture editor surfaces');
      await checkpoint(`Real TrueForge session ${wire.sessionId} delivers a proposal into the editor (deterministic inference fixture)`);
    }
    console.log('SecureForge editor checks passed:', results);
  } catch (error) {
    if (process.env.SECUREFORGE_EDITOR_REPORT) {
      await fs.writeFile(process.env.SECUREFORGE_EDITOR_REPORT, JSON.stringify({ passed: results, error: error.stack }, null, 2));
    }
    throw error;
  } finally {
    await workspace.close();
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === 'file' && document.uri.fsPath.startsWith(workspace.root + path.sep) && document.isDirty) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await fs.rm(root, { recursive: true, force: true });
  }
  // Checkpoint files are marked incomplete. Publish a terminal success receipt
  // only after editor buffers, workspace handles and test fixtures are cleaned.
  if (process.env.SECUREFORGE_EDITOR_REPORT) {
    await fs.writeFile(process.env.SECUREFORGE_EDITOR_REPORT,
      JSON.stringify({ passed: results, complete: true }, null, 2));
  }
};
