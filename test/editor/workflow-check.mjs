import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { registerWorkflows } from '../../extension/workflows.mjs';

// A real SDK/runtime proposal traverses Build's normal command handler.
// VS Code surfaces are deterministic fixtures in this specific regression.
export async function verifyBuildWorkflow({ root, model }) {
  const handlers = new Map();
  const errors = [];
  const disposable = () => ({ dispose() {} });
  let panel;
  let onDispose;
  const vscode = {
    commands: { registerCommand: (name, handler) => { handlers.set(name, handler); return disposable(); } },
    ProgressLocation: { Notification: 1 }, ViewColumn: { One: 1, Beside: 2 },
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      getConfiguration: () => ({ get: (name, fallback) => name === 'model' ? model : fallback }),
      openTextDocument: async uri => {
        const content = await readFile(uri.fsPath, 'utf8');
        return { uri, version: 1, isDirty: false, isClosed: false, getText: () => content };
      },
      onDidChangeTextDocument: disposable,
    },
    window: {
      createOutputChannel: () => ({ clear() {}, appendLine() {}, show() {}, dispose() {} }),
      // Native SecureForge is now a WebviewView; the review itself remains a
      // separate WebviewPanel. Exercise both registrations in this fixture.
      registerWebviewViewProvider: (id, provider, options) => {
        assert.equal(id, 'secureforge.agentSidebar');
        assert.ok(provider.resolveWebviewView);
        assert.equal(options.webviewOptions.retainContextWhenHidden, true);
        return disposable();
      },
      withProgress: async (_options, callback) => callback({}, { onCancellationRequested: disposable }),
      showWarningMessage: async (message, options, action) => {
        assert.match(message, /^Allow TrueForge tool propose_(edit|batch|patch_batch)\? \(request \d+\/8\)$/);
        assert.equal(options.modal, true);
        assert.equal(action, 'Allow once');
        return action;
      },
      showErrorMessage: message => errors.push(message),
      showInformationMessage: message => errors.push(message),
      showTextDocument: async () => {},
      createWebviewPanel: () => {
        panel = {
          webview: { postMessage() {}, onDidReceiveMessage: disposable },
          onDidDispose: callback => { onDispose = callback; return disposable(); },
          dispose: () => onDispose?.(),
        };
        return panel;
      },
    },
  };
  const extensionContext = { subscriptions: [] };
  registerWorkflows(vscode, extensionContext);
  await handlers.get('secureforge.runBuild')('Run the deterministic proposal handoff fixture');
  assert.deepEqual(errors, []);
  assert.ok(panel && extensionContext.subscriptions.includes(panel), 'Review uses the real extension context');
  assert.match(panel.webview.html, /Review proposed changes/);
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'first\nkeep\nlast\n');
  panel.dispose();
}
