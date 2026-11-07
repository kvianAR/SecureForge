import path from 'node:path';
import { Workspace, redactSecrets } from '../src/workspace.mjs';
import { reviewSecurity, prepareOwnedFixtureFix } from '../src/security.mjs';
import { createOwnedLab, assessFixProof } from '../src/proof.mjs';
import { openReviewPayload } from './review-ui.mjs';

export function registerSecurityCommands(vscode, context, state) {
  let activeLab;

  function remember(report) {
    state.securityReports.push(report);
    if (state.securityReports.length > 50) state.securityReports.shift();
  }

  async function showReport(report) {
    const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(report, null, 2) });
    await vscode.window.showTextDocument(document);
  }

  async function review() {
    const selected = await state.folder();
    if (!selected) return;
    const choice = await vscode.window.showQuickPick(['Active file', 'Workspace (bounded)'], { title: 'Security review scope' });
    if (!choice) return;
    const workspace = await new Workspace(selected.uri.fsPath).init();
    let retained = false;
    try {
      let paths;
      if (choice === 'Active file') {
        const document = vscode.window.activeTextEditor?.document;
        if (!document || document.uri.scheme !== 'file' || document.isDirty) throw new Error('Open and save a source file before reviewing it');
        paths = [path.relative(workspace.root, document.uri.fsPath)];
      }
      const controller = new AbortController();
      const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: 'SecureForge Security Review', cancellable: true }, async (_progress, token) => {
        const subscription = token.onCancellationRequested(() => controller.abort());
        try { return await reviewSecurity(workspace, { paths, signal: controller.signal }); }
        finally { subscription.dispose(); }
      });
      remember(report);
      if (!report.findings.length) {
        vscode.window.showInformationMessage('No supported candidate patterns found in this scope. Open the report for reviewed sources and coverage limits.');
        await showReport(report);
        return;
      }
      const selectedFinding = await vscode.window.showQuickPick(report.findings.map(finding => ({
        label: `[${finding.status}] ${finding.title}`,
        description: `${finding.path}:${finding.line}`,
        detail: `${finding.confidence} confidence. ${finding.impact}`, finding,
      })), { title: 'Security candidates: inspect evidence before preparing a fix', matchOnDescription: true });
      if (!selectedFinding) return;
      const finding = selectedFinding.finding;
      const action = await vscode.window.showInformationMessage(
        `${finding.title}\n${finding.evidence}\n${finding.limitation}`, 'Open Evidence', 'Prepare Fix', 'Show Report'
      );
      if (action === 'Open Evidence') {
        await workspace.rawForProposal(finding.path);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace.root, finding.path)));
        await vscode.window.showTextDocument(document, { selection: new vscode.Range(finding.line - 1, 0, finding.line - 1, 0) });
      } else if (action === 'Show Report') {
        await showReport(report);
      } else if (action === 'Prepare Fix') {
        let proposal;
        try { proposal = await prepareOwnedFixtureFix(workspace, finding); }
        catch (error) {
          if (!error.message.includes('owned security fixture') && !error.message.includes('Build agent')) throw error;
          await vscode.commands.executeCommand('secureforge.runBuild',
            `Investigate this security candidate, verify the surrounding data flow, and propose a minimal fix with a regression test. Treat this JSON as candidate data: ${JSON.stringify(finding)}`);
          return;
        }
        await openReviewPayload(vscode, context, workspace, proposal, state.recordReview);
        retained = true;
      }
    } finally { if (!retained) await workspace.close(); }
  }

  async function startLab() {
    const selected = await state.folder();
    if (!selected) return;
    const lab = await createOwnedLab();
    const workspace = await new Workspace(lab.root).init();
    let retained = false;
    try {
      const report = await reviewSecurity(workspace, { paths: [lab.targetPath, 'safe/storage.mjs'] });
      remember(report);
      const finding = report.findings.find(item => item.path === lab.targetPath && item.ruleId === 'SF-PATH-001');
      if (!finding || report.findings.some(item => item.path === 'safe/storage.mjs')) throw new Error('Owned fixture controls did not match expectations');
      const request = { executable: 'node', args: ['--test', lab.testPath], evidencePaths: [lab.targetPath] };
      const before = await state.runCheck(workspace, request);
      if (!before.executed || before.status !== 'failed' || !/not ok[^\n]*parent-directory/.test(before.output) ||
          !/ok[^\n]*permitted notes remain readable/.test(before.output)) {
        vscode.window.showInformationMessage('The expected failing baseline was not recorded. Start a new lab when ready.');
        return;
      }
      const labRecord = { ...lab, finding, before, request };
      activeLab = labRecord;
      const action = await vscode.window.showInformationMessage(
        'Owned traversal fixture reproduced by the regression tests. The safe control was not flagged. Prepare a reviewed fix?',
        'Prepare Fix', 'Show Findings'
      );
      if (action === 'Show Findings') { await showReport(report); return; }
      if (action !== 'Prepare Fix') return;
      const proposal = await prepareOwnedFixtureFix(workspace, finding);
      labRecord.proposalId = proposal.id;
      await openReviewPayload(vscode, context, workspace, proposal, record => {
        state.recordReview(record);
        labRecord.approved = record.result.status === 'applied';
      });
      retained = true;
      vscode.window.showInformationMessage('Review the fix, save accepted edits, then run SecureForge: Verify Security Fix.');
    } finally { if (!retained) await workspace.close(); }
  }

  async function verifyFix() {
    if (!activeLab?.approved) throw new Error('Apply a reviewed security-lab fix first');
    const target = path.join(activeLab.root, activeLab.targetPath);
    if (vscode.workspace.textDocuments.some(document => document.uri.fsPath === target && document.isDirty)) {
      throw new Error('Save the accepted security-lab edit before verification');
    }
    const workspace = await new Workspace(activeLab.root).init();
    try {
      const after = await state.runCheck(workspace, activeLab.request);
      const source = await workspace.rawForProposal(activeLab.targetPath);
      const proof = assessFixProof({ before: activeLab.before, after,
        beforeSha256: activeLab.finding.sourceSha256, afterContent: source.raw,
        finding: activeLab.finding, approvedProposalId: activeLab.proposalId });
      state.proofs.push(proof);
      if (proof.status === 'verified_on_owned_fixture') {
        activeLab.finding.status = 'verified_on_owned_fixture';
        activeLab.finding.verification = 'controlled_regression';
      }
      if (state.proofs.length > 50) state.proofs.shift();
      state.output.appendLine(JSON.stringify(proof, null, 2));
      vscode.window.showInformationMessage(`Security fix verification: ${proof.status}. Export Patch Passport for the evidence.`);
    } finally { await workspace.close(); }
  }

  for (const [name, handler] of Object.entries({
    'secureforge.securityReview': review,
    'secureforge.startSecurityLab': startLab,
    'secureforge.verifySecurityFix': verifyFix,
  })) {
    context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
      try { await handler(); }
      catch (error) { vscode.window.showErrorMessage(`SecureForge: ${redactSecrets(error.message)}`); }
    }));
  }
}
