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
  let lensProvider;
  let inlayProvider;
  let editor;
  class EventEmitter {
    constructor() { this.event = () => ({ dispose() {} }); }
    fire() {}
    dispose() {}
  }
  class Range { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }
  class CodeLens { constructor(range, command) { this.range = range; this.command = command; } }
  class ThemeColor { constructor(name) { this.name = name; } }
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class InlayHint { constructor(position, label, kind) { this.position = position; this.label = label; this.kind = kind; } }
  class InlayHintLabelPart { constructor(value) { this.value = value; } }
  class MarkdownString {
    appendMarkdown() { return this; }
    appendCodeblock() { return this; }
  }
  const vscode = {
    EventEmitter, Range, CodeLens, ThemeColor, MarkdownString, Position, InlayHint, InlayHintLabelPart,
    InlayHintKind: { Type: 1, Parameter: 2 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
    languages: { registerCodeLensProvider: (_selector, provider) => {
      lensProvider = provider;
      return disposable();
    }, registerInlayHintsProvider: (_selector, provider) => {
      inlayProvider = provider;
      return disposable();
    } },
    commands: { registerCommand: (name, handler) => { handlers.set(name, handler); return disposable(); } },
    ProgressLocation: { Notification: 1 }, ViewColumn: { One: 1, Beside: 2, Active: 1 },
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      getConfiguration: () => ({ get: (name, fallback) => name === 'model' ? model : fallback }),
      openTextDocument: async uri => {
        const content = await readFile(uri.fsPath, 'utf8');
        const lines = content.split('\n');
        return { uri, version: 1, isDirty: false, isClosed: false,
          languageId: 'python', lineCount: lines.length,
          lineAt: line => ({ text: lines[line] || '' }), getText: () => content };
      },
      onDidChangeTextDocument: disposable,
    },
    window: {
      visibleTextEditors: [],
      createTextEditorDecorationType: () => ({ dispose() {} }),
      onDidChangeVisibleTextEditors: disposable,
      createOutputChannel: () => ({ clear() {}, appendLine() {}, show() {}, dispose() {} }),
      // Native SecureForge uses a sidebar WebviewView for prompts; review is
      // rendered by CodeLens in the source editor without a review tab.
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
      showTextDocument: async document => {
        editor = { document, setDecorations() {}, revealRange() {} };
        vscode.window.activeTextEditor = editor;
        vscode.window.visibleTextEditors = [editor];
        return editor;
      },
      createWebviewPanel: () => { throw new Error('Inline review must not open a separate panel'); },
    },
  };
  const extensionContext = { subscriptions: [] };
  const state = registerWorkflows(vscode, extensionContext);
  await handlers.get('secureforge.runBuild')('Run the deterministic proposal handoff fixture');
  assert.deepEqual(errors, []);
  assert.ok(lensProvider, 'Native apply and undo CodeLens commands must remain available');
  assert.ok(inlayProvider, 'Interactive right-end-of-line controls must be registered');
  assert.equal(state.currentReviewState()?.type, 'inlineReviewState');
  assert.equal(state.currentReviewState()?.status, 'pending');
  assert.ok(state.currentReviewState()?.hunks.length,
    'The current review is cached so a late sidebar can restore it');
  assert.ok(editor, 'The original source document is opened in the normal editor');
  const buttons = inlayProvider.provideInlayHints(editor.document).flatMap(hint =>
    Array.isArray(hint.label) ? hint.label : []);
  assert.ok(buttons.some(part => part.command.command === 'secureforge.inlineReview.accept'));
  assert.ok(buttons.some(part => part.command.command === 'secureforge.inlineReview.reject'));
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'first\nkeep\nlast\n');
}
