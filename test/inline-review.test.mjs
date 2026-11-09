import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { Workspace } from '../src/workspace.mjs';
import { ProposalStore } from '../src/proposals.mjs';
import { registerInlineReview } from '../extension/inline-review.mjs';

async function harness(t, proposed = 'HELLO\nkeep\nBYE\n', { sourceVisible = true, otherActive = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-inline-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await new Workspace(root).init();
  const original = 'hello\nkeep\nbye\n';
  const file = path.join(workspace.root, 'sample.py');
  await writeFile(file, original);
  const store = new ProposalStore(workspace);
  const base = await workspace.rawForProposal('sample.py');
  const summary = await store.proposeEdit({
    path: 'sample.py', expectedSha256: base.hash, proposedContent: proposed,
    rationale: 'Test inline editor review',
  });
  const payload = store.getProposal(summary.id);
  const handlers = new Map();
  const events = [];
  const notice = [];
  let provider;
  let hintsProvider;
  let changedHandler;
  let docText = original;
  const disposable = () => ({ dispose() {} });
  const pos = offset => {
    const before = docText.slice(0, offset);
    const line = before.split('\n').length - 1;
    return { line, character: before.length - before.lastIndexOf('\n') - 1 };
  };
  const offset = point => {
    const lines = docText.split('\n');
    return lines.slice(0, point.line).reduce((sum, text) => sum + text.length + 1, 0) + point.character;
  };
  const document = {
    uri: { scheme: 'file', fsPath: file }, version: 1, isDirty: false, isClosed: false,
    languageId: 'python', getText: () => docText, positionAt: pos, offsetAt: offset,
    get lineCount() { return docText.split('\n').length; },
    lineAt: line => ({ text: docText.split('\n')[line] ?? '' }),
  };
  class EventEmitter { constructor() { this.event = () => disposable(); } fire() {} dispose() {} }
  class Range {
    constructor(a, b, c, d) {
      if (typeof a === 'object') { this.start = a; this.end = b; }
      else { this.start = { line: a, character: b }; this.end = { line: c, character: d }; }
    }
  }
  class CodeLens { constructor(range, command) { this.range = range; this.command = command; } }
  class ThemeColor { constructor(name) { this.name = name; } }
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class InlayHint { constructor(position, label, kind) {
    this.position = position; this.label = label; this.kind = kind;
  } }
  class InlayHintLabelPart { constructor(value) { this.value = value; } }
  class MarkdownString {
    constructor() { this.text = ''; }
    appendMarkdown(text) { this.text += text; return this; }
    appendCodeblock(text) { this.text += '\n' + text + '\n'; return this; }
  }
  class WorkspaceEdit {
    constructor() { this.edits = []; }
    replace(uri, range, newText) { this.edits.push({ uri, range, newText }); }
  }
  const editor = { document, viewColumn: 1, setDecorations() {}, revealRange() {} };
  const otherEditor = { document: { uri: { fsPath: path.join(workspace.root, 'other.py') } },
    viewColumn: 2, setDecorations() {}, revealRange() {} };
  let showCalls = 0;
  const undoStatus = { visible: false, name: '', text: '', tooltip: '', command: '',
    show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
  const vscode = {
    EventEmitter, Range, CodeLens, ThemeColor, MarkdownString, WorkspaceEdit,
    Position, InlayHint, InlayHintLabelPart, InlayHintKind: { Type: 1, Parameter: 2 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
    StatusBarAlignment: { Right: 2 },
    ViewColumn: { Active: 1 }, Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
    commands: {
      registerCommand: (name, fn) => { handlers.set(name, fn); return disposable(); },
    },
    languages: {
      registerCodeLensProvider: (_selector, value) => { provider = value; return disposable(); },
      registerInlayHintsProvider: (_selector, value) => { hintsProvider = value; return disposable(); },
    },
    workspace: {
      isTrusted: true, openTextDocument: async () => document,
      onDidChangeTextDocument: handler => { changedHandler = handler; return disposable(); },
      applyEdit: async edit => {
        const offsets = edit.edits.map(item => ({
          from: offset(item.range.start), to: offset(item.range.end), text: item.newText,
        })).sort((a, b) => b.from - a.from);
        for (const item of offsets) docText = docText.slice(0, item.from) + item.text + docText.slice(item.to);
        document.version++;
        document.isDirty = true;
        changedHandler?.({ document });
        return true;
      },
    },
    window: {
      visibleTextEditors: sourceVisible ? (otherActive ? [editor, otherEditor] : [editor]) : [],
      activeTextEditor: otherActive ? otherEditor : sourceVisible ? editor : undefined,
      createTextEditorDecorationType: () => ({ dispose() {} }),
      createStatusBarItem: () => undoStatus,
      onDidChangeVisibleTextEditors: () => disposable(),
      showTextDocument: async () => {
        showCalls++;
        vscode.window.visibleTextEditors = [editor];
        vscode.window.activeTextEditor = editor;
        return editor;
      },
      showWarningMessage: message => notice.push(message),
    },
  };
  const context = { subscriptions: [] };
  const controller = registerInlineReview(vscode, context, {
    notify: event => events.push(event),
    onApplied: event => events.push({ type: 'receipt', ...event }),
  });
  t.after(() => controller.dispose());
  await controller.open(workspace, payload);
  return {
    root, file, original, document, controller, provider, hintsProvider, handlers, events, notice, undoStatus,
    showCalls: () => showCalls,
    text: () => docText, get hunks() { return payload.proposals?.[0]?.hunks; },
  };
}

test('native CodeLens review accepts one hunk and rejects another without a separate panel', async t => {
  const fixture = await harness(t);
  const { controller, provider, hintsProvider, document, events, original, file } = fixture;
  const initialHints = hintsProvider.provideInlayHints(document);
  const controls = initialHints.flatMap(hint => Array.isArray(hint.label) ? hint.label : []);
  assert.ok(controls.some(part => part.command?.command === 'secureforge.inlineReview.accept'));
  assert.ok(controls.some(part => part.command?.command === 'secureforge.inlineReview.reject'));
  assert.equal(initialHints.length, 2, 'Each changed line gets exactly one inlay hint');
  for (const hint of initialHints) {
    assert.equal(hint.label.map(part => part.value).join(''), '✅ Accept | ❌ Reject');
    assert.ok(hint.label.map(part => part.value).join('').length < 43,
      'The complete label fits VS Code\'s default per-line inlay limit');
    assert.equal(hint.label[0].command.command, 'secureforge.inlineReview.accept');
    assert.equal(hint.label[1].value, ' | ');
    assert.equal(hint.label[1].command, undefined);
    assert.equal(hint.label[2].command.command, 'secureforge.inlineReview.reject');
    assert.ok(hint.label[0].tooltip && hint.label[2].tooltip,
      'The complete code preview remains accessible on hover');
    assert.equal(hint.tooltip, undefined, 'Do not display duplicate previews');
    assert.deepEqual(Array.from(hint.label[0].tooltip.isTrusted.enabledCommands), [
      'secureforge.inlineReview.accept', 'secureforge.inlineReview.reject',
    ]);
    assert.match(hint.label[0].tooltip.text, /\[✅ Accept\]\(command:secureforge\.inlineReview\.accept\?/);
    assert.match(hint.label[0].tooltip.text, /\[❌ Reject\]\(command:secureforge\.inlineReview\.reject\?/);
    assert.match(hint.label[0].tooltip.text, /Original:/);
    assert.match(hint.label[0].tooltip.text, /Proposed:/);
  }
  const clickLenses = provider.provideCodeLenses(document);
  assert.equal(clickLenses.filter(item =>
    item.command.command === 'secureforge.inlineReview.accept').length, 0,
    'Per-hunk CodeLens is intentionally absent; Cmd-click the inline hint or use chat');
  assert.equal(clickLenses.filter(item =>
    item.command.command === 'secureforge.inlineReview.reject').length, 0,
    'Do not duplicate per-hunk Accept/Reject controls above the code');
  assert.ok(clickLenses.some(item => item.command.command === 'secureforge.inlineReview.acceptAll'),
    'Bulk actions remain accessible without opening the sidebar');
  assert.ok(clickLenses.some(item => item.command.command === 'secureforge.inlineReview.rejectAll'));
  assert.ok(initialHints.every(hint => hint.position.character ===
    document.lineAt(hint.position.line).text.length), 'Controls stay at the right end of the source line');
  assert.equal(await readFile(file, 'utf8'), original, 'Staging must not edit source');
  const state = events.find(item => item.type === 'inlineReviewState' && item.status === 'pending');
  assert.equal(state.hunks.length, 2);
  await controller.action('accept', state.hunks[0].id);
  await controller.action('reject', state.hunks[1].id);
  const approval = provider.provideCodeLenses(document);
  assert.ok(approval.some(item => item.command.command === 'secureforge.inlineReview.apply'));
  assert.equal(await readFile(file, 'utf8'), original, 'Hunk selection alone must not change disk');
  await controller.action('apply');
  assert.equal(controller.status, 'applied');
  assert.equal(fixture.undoStatus.visible, true, 'Undo stays visible after Apply');
  assert.equal(fixture.undoStatus.command, 'secureforge.inlineReview.undo');
  assert.ok(provider.provideCodeLenses(document).some(
    lens => lens.command.command === 'secureforge.inlineReview.undo'),
    'Undo must also remain available in the editor');
  assert.equal(fixture.text(), 'HELLO\nkeep\nbye\n');
  assert.equal(await readFile(file, 'utf8'), original, 'Apply stays in the editor until Save');
  await controller.action('undo');
  assert.equal(controller.status, 'undone');
  assert.equal(fixture.undoStatus.visible, false, 'Undo disappears only after a successful rollback');
  assert.equal(fixture.text(), original);
});

test('source changed on disk blocks inline apply instead of overwriting it', async t => {
  const fixture = await harness(t);
  const initial = fixture.events.find(item => item.type === 'inlineReviewState');
  for (const item of initial.hunks) await fixture.controller.action('accept', item.id);
  await writeFile(fixture.file, 'externally modified\n');
  await fixture.controller.action('apply');
  assert.equal(fixture.controller.status, 'blocked');
  assert.equal(fixture.text(), fixture.original);
  assert.equal(await readFile(fixture.file, 'utf8'), 'externally modified\n');
  assert.match(fixture.events.at(-1).message, /Stale proposal/);
});

test('unknown hunk IDs and unapproved apply are refused', async t => {
  const fixture = await harness(t);
  await assert.rejects(fixture.controller.action('accept', 'not-a-hunk'), /Unknown review hunk/);
  await assert.rejects(fixture.controller.action('apply'), /Accept or reject every hunk/);
  assert.equal(fixture.text(), fixture.original);
});

test('reuses an already visible source instead of opening it in another editor group', async t => {
  const fixture = await harness(t, 'HELLO\nkeep\nBYE\n', { otherActive: true });
  assert.equal(fixture.showCalls(), 0, 'Review must not open a second source tab');
  const state = fixture.events.find(event => event.type === 'inlineReviewState');
  await fixture.controller.action('focus', state.hunks[0].id);
  assert.equal(fixture.showCalls(), 0, 'Chat navigation must reuse the visible editor');
  assert.equal(await readFile(fixture.file, 'utf8'), fixture.original);
});

test('opens a source file once when it is not already visible', async t => {
  const fixture = await harness(t, 'HELLO\nkeep\nBYE\n', { sourceVisible: false });
  assert.equal(fixture.showCalls(), 1);
});

test('line-end hint controls stay clickable and refresh when a hunk is accepted', async t => {
  const fixture = await harness(t);
  const before = fixture.hintsProvider.provideInlayHints(fixture.document);
  const accepts = before.flatMap(h => Array.isArray(h.label) ? h.label : []).filter(
    p => p.command?.command === 'secureforge.inlineReview.accept');
  assert.equal(accepts.length, 2);
  assert.equal(accepts[0].command.arguments.length, 1);
  assert.equal(accepts[0].value, '✅ Accept');
  assert.ok(before.every(hint => Array.isArray(hint.label)),
    'Do not add a long inline preview that clips the following buttons');
  await fixture.handlers.get('secureforge.inlineReview.accept')(accepts[0].command.arguments[0]);
  const after = fixture.hintsProvider.provideInlayHints(fixture.document);
  assert.ok(after.flatMap(h => Array.isArray(h.label) ? h.label : []).some(
    p => p.command?.command === 'secureforge.inlineReview.accept' && p.value === '✅ Accepted'));
  assert.ok(after.every(hint =>
    hint.label.map(part => part.value).join('').includes(' | ❌ Reject')),
    'Reject remains visible and clickable after accepting another hunk');
  assert.equal(fixture.text(), fixture.original);
});

test('Accept all selects every hunk without writing, Apply remains explicit, and Undo is persistent', async t => {
  const fixture = await harness(t);
  const { controller, provider, document } = fixture;
  const menu = provider.provideCodeLenses(document);
  assert.ok(menu.some(lens => lens.command.command === 'secureforge.inlineReview.acceptAll'));
  assert.ok(menu.some(lens => lens.command.command === 'secureforge.inlineReview.rejectAll'));
  await fixture.handlers.get('secureforge.inlineReview.acceptAll')();
  const state = fixture.events.at(-1);
  assert.equal(state.status, 'pending');
  assert.equal(state.accepted, 2);
  assert.equal(state.decided, 2);
  assert.equal(fixture.text(), fixture.original, 'Bulk approval alone cannot edit any buffer');
  await fixture.handlers.get('secureforge.inlineReview.apply')();
  assert.equal(controller.status, 'applied');
  assert.equal(fixture.text(), 'HELLO\nkeep\nBYE\n');
  assert.equal(fixture.undoStatus.visible, true);
  await fixture.handlers.get('secureforge.inlineReview.undo')();
  assert.equal(controller.status, 'undone');
  assert.equal(fixture.text(), fixture.original);
  assert.equal(fixture.undoStatus.visible, false);
});

test('Reject all completes without any write, with no unsafe Undo receipt', async t => {
  const fixture = await harness(t);
  await fixture.handlers.get('secureforge.inlineReview.rejectAll')();
  const state = fixture.events.at(-1);
  assert.equal(state.accepted, 0);
  assert.equal(state.decided, 2);
  assert.equal(state.status, 'pending');
  const finish = fixture.provider.provideCodeLenses(fixture.document).find(
    lens => lens.command.command === 'secureforge.inlineReview.apply');
  assert.match(finish.command.title, /Finish rejection/);
  await fixture.controller.action('apply');
  assert.equal(fixture.controller.status, 'rejected');
  assert.equal(fixture.text(), fixture.original);
  assert.equal(await readFile(fixture.file, 'utf8'), fixture.original);
  assert.equal(fixture.undoStatus.visible, false);
});
