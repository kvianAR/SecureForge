import { Workspace, redactSecrets } from '../src/workspace.mjs';
import { createTrueForgeClient, resolveTrueForgeModel } from '../src/agent.mjs';
import { LiveRun, localTrueForgeUrl } from '../src/live-run.mjs';
import { runApprovedCommand } from '../src/commands.mjs';
import { registerInlineReview } from './inline-review.mjs';
import { createPassport } from '../src/passport.mjs';
import { registerSecurityCommands } from './security-ui.mjs';
import path from 'node:path';
import { assembleContext } from '../src/context.mjs';
import { registerAgentPanel } from './agent-panel.mjs';

// A model can report "already fixed" even after an unsupported test command.
// Keep generated explanation separate from independently recorded verification.
export function describeNoProposal(reply, receipts = []) {
  const passed = receipts.filter(receipt => receipt?.status === 'passed' && receipt.executed === true).length;
  const content = typeof reply === 'string' && reply.trim()
    ? redactSecrets(reply.trim()).slice(0, 2200)
    : 'The agent finished without staging a patch. SecureForge applied no changes.';
  const verification = passed
    ? `SecureForge recorded ${passed} passing verification command(s) for this run. Check which test files were executed before relying on them.`
    : 'SecureForge has no passing test receipt for this run. Rejected or unsupported commands did not verify the change. Review the Git diff and run the targeted tests before treating the task as complete.';
  return `${content}\n\n${verification}`;
}

// A passing command only verifies bytes saved on disk. Running while a
// workspace document is dirty can silently test the old code rather than the
// newly approved editor patch. Keep this check separate from tool approval.
export function requireSavedWorkspaceDocuments(vscode, workspace) {
  const roots = [workspace.root, workspace.requestedRoot]
    .filter(root => typeof root === 'string' && root.length);
  const inWorkspace = file => roots.some(root => {
    const relative = path.relative(root, file);
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) &&
      !path.isAbsolute(relative));
  });
  for (const document of vscode.workspace?.textDocuments ?? []) {
    if (document?.isDirty && document.uri?.scheme === 'file' &&
        typeof document.uri.fsPath === 'string' && inWorkspace(document.uri.fsPath)) {
      throw new Error('Save all edited files in this workspace before verification. Tests run saved disk contents, not unsaved editor buffers.');
    }
  }
}

export function registerWorkflows(vscode, context) {
  const output = vscode.window.createOutputChannel('SecureForge Activity');
  const receipts = [];
  const applied = [];
  const securityReports = [];
  const proofs = [];
  const mentions = [];
  let activeRun;
  let building = false;
  let buildController;
  const listeners = new Set();
  // A review can begin before VS Code resolves the secondary-sidebar view.
  // Keep its latest bounded state until the webview sends its ready handshake.
  let latestInlineReviewState;
  function broadcast(message) {
    if (message?.type === 'inlineReviewState') {
      latestInlineReviewState = Array.isArray(message.hunks) && message.hunks.length
        ? message : undefined;
    }
    for (const listener of listeners) listener(message);
  }
  function subscribe(listener) {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  }
  context.subscriptions.push(output, { dispose: () => { buildController?.abort(); void activeRun?.cancel(); } });

  async function folder() {
    if (!vscode.workspace.isTrusted) throw new Error('A trusted local workspace is required');
    const folders = vscode.workspace.workspaceFolders?.filter(item => item.uri.scheme === 'file');
    if (!folders?.length) throw new Error('Open a local workspace first');
    if (folders.length === 1) return folders[0];
    return (await vscode.window.showQuickPick(folders.map(item => ({ label: item.name, folder: item })),
      { title: 'Choose the workspace' }))?.folder;
  }

  function recordReview(record) {
    applied.push({ ...record, recordedAt: new Date().toISOString(), group: {
      id: record.group.id,
      files: record.group.files.map(file => ({
        id: file.id, path: file.path, baseSha256: file.baseSha256,
        hunks: file.hunks.map(hunk => ({ id: hunk.id, startLine: hunk.startLine })),
      })),
    } });
    if (applied.length > 100) applied.shift();
    const status = record.result?.status;
    if (status === 'applied' || status === 'undone' || status === 'rejected') {
      broadcast({ type: 'reviewResult', status, accepted: record.result?.accepted ?? 0 });
    }
  }

  // Register editor surfaces only when a proposal exists. This keeps context
  // previews and verification commands independent of open editor state.
  let inlineReview;
  function getInlineReview() {
    if (!inlineReview) {
      inlineReview = registerInlineReview(vscode, context, { onApplied: recordReview, notify: broadcast });
      context.subscriptions.push({ dispose: () => { void inlineReview.dispose(); } });
    }
    return inlineReview;
  }

  async function build(initialTask, inline = false) {
    if (!vscode.workspace.isTrusted) throw new Error('A trusted local workspace is required');
    if (activeRun) throw new Error('Cancel or finish the current agent run first');
    const editor = inline ? vscode.window.activeTextEditor : undefined;
    if (inline && (!editor || editor.selection.isEmpty || editor.document.isDirty)) {
      throw new Error('Select code in a saved source file before requesting an inline edit');
    }
    const selected = inline ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : await folder();
    if (!selected) return { status: 'cancelled' };
    broadcast({ type: 'workspace', name: selected.name });
    const selectionVersion = editor?.document.version;
    const startOffset = inline ? editor.document.offsetAt(editor.selection.start) : undefined;
    const endOffset = inline ? editor.document.offsetAt(editor.selection.end) : undefined;
    const task = typeof initialTask === 'string' ? initialTask : await vscode.window.showInputBox({
      title: inline ? 'SecureForge Inline Edit' : 'SecureForge Build',
      prompt: 'Describe the change. Optional @file:path and @symbol:name mentions.', value: mentions.join(' '),
    });
    if (!task?.trim()) return { status: 'cancelled' };
    buildController.signal.throwIfAborted();
    mentions.length = 0;
    const settings = vscode.workspace.getConfiguration('secureforge');
    const sourceWorkspace = await new Workspace(selected.uri.fsPath).init();
    let taskContext;
    let selection;
    try {
      if (inline) {
        const source = await sourceWorkspace.rawForProposal(path.relative(sourceWorkspace.root, editor.document.uri.fsPath));
        if (editor.document.version !== selectionVersion || source.raw !== editor.document.getText()) {
          throw new Error('Selected document changed while preparing the task');
        }
        selection = { path: source.relative, baseSha256: source.hash, startOffset, endOffset };
      }
      taskContext = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: 'SecureForge context selection', cancellable: true }, async (_progress, token) => {
        const subscription = token.onCancellationRequested(() => buildController.abort());
        try { return await assembleContext(sourceWorkspace, task, {
          budgetBytes: settings.get('contextBudgetBytes', 24000), signal: buildController.signal, selectedPath: selection?.path,
        }); } finally { subscription.dispose(); }
      });
    } finally { await sourceWorkspace.close(); }
    if (taskContext.workspaceMismatch) {
      const currentName = redactSecrets(String(selected.name || 'Unknown')).slice(0, 100);
      const packageOnly = taskContext.workspaceMismatch.code === 'FLASK_PACKAGE_SUBFOLDER';
      broadcast({ type: 'workspaceMismatch', code: taskContext.workspaceMismatch.code,
        message: packageOnly
          ? `You're currently in ${currentName}, which appears to be Flask's src/flask Python package. Open the Flask repository root two folders above, so the source, project configuration and regression tests are all available. No model was called and no files were changed.`
          : `You're currently in ${currentName}. This task requires existing Flask source, but this folder contains no Python files. Choose Recent projects to find a previously opened Flask project, or Browse folders to locate it on your Mac. No model was called and no files were changed.` });
      return { status: 'workspace_mismatch' };
    }
    const baseUrl = localTrueForgeUrl(settings.get('trueforgeUrl', 'http://localhost:8790'));
    const model = await resolveTrueForgeModel({
      configured: settings.get('model', ''),
      baseUrl,
      chooseModel: names => vscode.window.showQuickPick(names, { title: 'Choose a local TrueForge model' }),
      enterModel: () => vscode.window.showInputBox({
        title: 'TrueForge model', prompt: 'Enter a configured model FQN from TrueForge Settings → Models',
      }),
    });
    if (!model?.trim()) return { status: 'cancelled' };
    buildController.signal.throwIfAborted();
    const client = await createTrueForgeClient({ baseUrl });
    buildController.signal.throwIfAborted();
    let outputBytes = 0;
    output.clear();
    // Keep the editor and chat visible; diagnostics remain available in the Output channel.
    output.appendLine(`TrueForge ${baseUrl} | Build | ${model}`);
    output.appendLine(`Context ${taskContext.usedBytes}/${taskContext.budgetBytes} UTF-8 bytes (${taskContext.tokenEstimate} estimated tokens)`);
    for (const source of taskContext.sources) output.appendLine(`${source.path}:${source.startLine}-${source.endLine} — ${source.reason}`);
    broadcast({ type: 'context', summary: `${taskContext.usedBytes}/${taskContext.budgetBytes} UTF-8 bytes\n` +
      taskContext.sources.map(source => `${source.path}:${source.startLine}-${source.endLine} | ${source.reason}`).join('\n') });
    activeRun = new LiveRun({
      client, root: selected.uri.fsPath,
      verifyCommand: (workspace, request, signal) => runCheck(workspace, request, signal),
      onEvent(event) {
        if (outputBytes > 64 * 1024) return;
        const line = redactSecrets(event.content || event.type);
        outputBytes += Buffer.byteLength(line);
        output.appendLine(line.slice(0, 4000));
        broadcast({ type: 'activity', text: line.slice(0, 4000) });
      },
      approveTool: async ({ sessionId, toolName, index, limit }) => {
        // The runtime's approval ref is resolved against its model.message.
        // Never approve a tool whose identity could not be established.
        if (!['propose_edit', 'propose_batch', 'propose_patch_batch', 'run_command'].includes(toolName)) {
          output.appendLine('Unidentified TrueForge tool request was denied before execution.');
          vscode.window.showWarningMessage('SecureForge denied an unidentified TrueForge tool request. Inspect Activity and retrieved files.');
          return false;
        }
        const action = toolName === 'run_command'
          ? 'The exact test command still requires a separate local confirmation before execution.'
          : 'The tool can only stage an in-memory patch. Applying editor changes requires separate hunk approval.';
        return await vscode.window.showWarningMessage(
          `Allow TrueForge tool ${toolName}? (request ${index}/${limit})`,
          { modal: true,
            detail: `Session ${sessionId}.\n${action}\nIf this same request keeps appearing, Cancel the Build and inspect SecureForge Activity; do not approve indefinitely.` },
          'Allow once'
        ) === 'Allow once';
      },
    });
    const run = activeRun;
    const previousReceipts = receipts.length;
    try {
      const payload = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'SecureForge Build', cancellable: true,
      }, async (_progress, token) => {
        const subscription = token.onCancellationRequested(() => { void run.cancel(); });
        try { return await run.run({ model: model.trim(), task, context: taskContext, selection }); }
        finally { subscription.dispose(); }
      });
      if (!payload.proposals.length) {
        broadcast({ type: 'noProposal', message: describeNoProposal(payload.reply, receipts.slice(previousReceipts)) });
        return { status: 'no_proposal' };
      }
      const workspace = await new Workspace(selected.uri.fsPath).init();
      try {
        const review = getInlineReview();
        await review.open(workspace, payload, record => {
          recordReview({ ...record, sessionId: payload.sessionId });
        });
        broadcast({ type: 'reviewReady', fileCount: payload.proposals.length, message: payload.reply || '' });
        review.publish();
      } catch (error) { await workspace.close(); throw error; }
      return { status: 'review' };
    } finally {
      activeRun = undefined;
    }
  }

  async function guardedBuild(task, inline = false) {
    if (building) throw new Error('A Build request is already active');
    building = true;
    buildController = new AbortController();
    try { return await build(task, inline); }
    finally { building = false; buildController = undefined; }
  }

  async function previewContext() {
    const selected = await folder();
    if (!selected) return;
    const task = await vscode.window.showInputBox({ title: 'Preview task context', prompt: 'Task with optional @file:path and @symbol:name' });
    if (!task?.trim()) return;
    const workspace = await new Workspace(selected.uri.fsPath).init();
    try {
      const result = await assembleContext(workspace, task, { budgetBytes: vscode.workspace.getConfiguration('secureforge').get('contextBudgetBytes', 24000) });
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(result, null, 2) }));
    } finally { await workspace.close(); }
  }

  async function attachFile() {
    const selected = await folder();
    if (!selected) return;
    const workspace = await new Workspace(selected.uri.fsPath).init();
    try {
      const file = await vscode.window.showQuickPick(await workspace.listFiles(), { title: 'Attach a file to the next Build request' });
      if (file) { const mention = `@file:${JSON.stringify(file)}`; mentions.push(mention); return mention; }
    } finally { await workspace.close(); }
  }

  async function attachSymbol() {
    const symbol = await vscode.window.showInputBox({ title: 'Attach a symbol to the next Build request',
      validateInput: value => /^[A-Za-z_$][\w$]{1,99}$/.test(value) ? undefined : 'Enter a symbol of 2..100 characters' });
    if (symbol) { const mention = `@symbol:${symbol}`; mentions.push(mention); return mention; }
  }

  async function verify() {
    const selected = await folder();
    if (!selected) return;
    const choice = await vscode.window.showQuickPick(['Node test', 'Python pytest'], {
      title: 'Choose a verification runner',
    });
    if (!choice) return;
    const workspace = await new Workspace(selected.uri.fsPath).init();
    try {
      const files = await workspace.listFiles({ maxFiles: 2500 });
      const eligible = files.filter(file => choice === 'Node test'
        ? /\.(?:test|spec)\.(?:mjs|cjs|js)$/.test(file)
        : /(?:^|\/)test_[\w.-]+\.py$/.test(file));
      if (!eligible.length) {
        vscode.window.showInformationMessage('No supported test files found in this workspace.');
        return;
      }
      const selection = await vscode.window.showQuickPick(eligible.map(file => ({
        label: file,
      })), {
        title: 'Select tests to run',
        placeHolder: 'Choose up to 20 test files. Review and approve the command before it executes.',
        canPickMany: true,
      });
      if (!selection?.length) return;
      if (selection.length > 20) throw new Error('Select at most 20 test files');
      const names = selection.map(item => item.label);
      const request = choice === 'Node test'
        ? { executable: 'node', args: ['--test', ...names] }
        : { executable: 'python3', args: ['-m', 'pytest', ...names, '-q'] };
      const receipt = await runCheck(workspace, request);
      broadcast({ type: 'verificationResult', status: receipt.status,
        executed: receipt.executed, fileCount: names.length });
      return receipt;
    } finally { await workspace.close(); }
  }

  async function runCheck(workspace, request, parentSignal) {
    requireSavedWorkspaceDocuments(vscode, workspace);
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    if (parentSignal?.aborted) controller.abort();
    try {
      const receipt = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'SecureForge verification', cancellable: true,
      }, async (_progress, token) => {
        const subscription = token.onCancellationRequested(() => controller.abort());
        try {
          return await runApprovedCommand({ workspace, request, signal: controller.signal,
            approve: async command => {
              requireSavedWorkspaceDocuments(vscode, workspace);
              const confirmed = await vscode.window.showWarningMessage(
                'Run this verification command?', { modal: true, detail:
                  `${command.executable} ${command.args.join(' ')}\nWorking directory: ${command.cwd}\nPython source path: ${command.pythonSourcePath || '(not set)'}\nTimeout: ${command.timeoutMs} ms\nTests execute repository code with your local user permissions. Save all edits before verifying them.` },
                'Run verification'
              ) === 'Run verification';
              if (confirmed) requireSavedWorkspaceDocuments(vscode, workspace);
              return confirmed;
            },
          });
        } finally { subscription.dispose(); }
      });
      receipts.push(receipt);
      if (receipts.length > 100) receipts.shift();
      output.appendLine(`Verification ${receipt.status}\n${receipt.output}`);
      output.show(true);
      return receipt;
    } finally { parentSignal?.removeEventListener('abort', abort); }
  }

  async function exportPassport() {
    const passport = createPassport({ reviews: applied, receipts, securityReports, proofs });
    const uri = await vscode.window.showSaveDialog({ title: 'Export Patch Passport',
      defaultUri: vscode.workspace.workspaceFolders?.[0]
        ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, `SecureForge-Patch-Passport-${passport.id}.json`)
        : undefined,
      filters: { 'Patch Passport JSON': ['json'] } });
    if (!uri) return;
    if (uri.scheme !== 'file') throw new Error('Choose a local export file');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(passport, null, 2)));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  }

  const handlers = {
    'secureforge.runBuild': task => typeof task === 'string' ? guardedBuild(task) : vscode.commands.executeCommand('secureforge.openAgentPanel'),
    'secureforge.inlineEdit': () => guardedBuild(undefined, true),
    'secureforge.previewContext': previewContext,
    'secureforge.attachFile': attachFile,
    'secureforge.attachSymbol': attachSymbol,
    'secureforge.cancelRun': () => { buildController?.abort(); return activeRun?.cancel(); },
    'secureforge.runVerification': verify,
    'secureforge.exportPassport': exportPassport,
  };
  for (const [name, handler] of Object.entries(handlers)) {
    context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
      try { return await handler(...args); }
      catch (error) {
        const message = redactSecrets(error.message);
        output.appendLine(message);
        broadcast({ type: 'error', message });
        vscode.window.showErrorMessage(`SecureForge: ${message}`);
      }
    }));
  }
  const state = { folder, receipts, applied, securityReports, proofs, output, runCheck, recordReview, subscribe,
    currentReviewState: () => latestInlineReviewState,
    openInlineReview: (workspace, payload, callback) => getInlineReview().open(workspace, payload, callback) };
  registerSecurityCommands(vscode, context, state);
  registerAgentPanel(vscode, context, { run: guardedBuild, cancel: () => { buildController?.abort(); return activeRun?.cancel(); }, attachFile, attachSymbol,
    subscribe, currentReviewState: state.currentReviewState, reviewAction: (action, id) => {
      if (!inlineReview) throw new Error('No inline review is active');
      return inlineReview.action(action, id);
    } });
  return state;
}
