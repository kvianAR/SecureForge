import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { Workspace, sha256 } from '../src/workspace.mjs';
import { ProposalStore } from '../src/proposals.mjs';
import { createReviewGroup } from '../src/review-group.mjs';
import { applyReviewGroup, undoReviewGroup } from './apply-review.mjs';

const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

export async function readProposalFile(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_IMPORT_BYTES) {
      throw new Error('Proposal JSON must be a regular file no larger than 4 MiB');
    }
    const chunks = [];
    let bytes = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_IMPORT_BYTES + 1 - bytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return Buffer.concat(chunks, bytes).toString('utf8');
      bytes += bytesRead;
      if (bytes > MAX_IMPORT_BYTES) throw new Error('Proposal JSON exceeds 4 MiB');
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
}

export function registerReviewCommands(vscode, context, onApplied = () => {}, openInline) {
  async function openReview(demo) {
    if (!vscode.workspace.isTrusted) throw new Error('Open a trusted local workspace');
    const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file');
    if (!folders?.length) throw new Error('Open a local project folder first');
    const choice = folders.length === 1 ? { folder: folders[0] } : await vscode.window.showQuickPick(
      folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      { title: 'Choose the workspace for this review' }
    );
    if (!choice) return;
    let proposal;
    if (!demo) {
      const selected = await vscode.window.showOpenDialog({
        title: 'Open an exported SecureForge v1 proposal',
        canSelectMany: false,
        filters: { 'Proposal JSON': ['json'] },
      });
      if (!selected?.length) return;
      if (selected[0].scheme !== 'file') throw new Error('Proposal JSON must be a local file');
      const json = await readProposalFile(selected[0].fsPath);
      proposal = JSON.parse(json);
    }
    const workspace = await new Workspace(choice.folder.uri.fsPath).init();
    try {
      if (demo) {
        const source = await workspace.rawForProposal('fixtures/review-demo.py');
        if (!source.raw.includes('return "Hello"') || !source.raw.includes('return "Ready"')) {
          throw new Error('Demo fixture changed. Restore fixtures/review-demo.py before preparing another demo.');
        }
        const store = new ProposalStore(workspace);
        const summary = await store.proposeEdit({
          path: source.relative,
          expectedSha256: source.hash,
          proposedContent: source.raw.replace('return "Hello"', 'return "Hello, developer"')
            .replace('return "Ready"', 'return "Ready for review"'),
          rationale: 'Local synthetic review demo. Independently accept or reject the two changes.',
        });
        proposal = store.getProposal(summary.id);
      }
      if (openInline) await openInline(workspace, proposal, onApplied);
      else await openReviewPayload(vscode, context, workspace, proposal, onApplied);
    } catch (error) {
      await workspace.close();
      throw error;
    }
  }
  for (const [command, demo] of [['secureforge.reviewProposal', false], ['secureforge.reviewDemo', true]]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
      try {
        await openReview(demo);
      } catch (error) {
        // File contents and tool payloads must not enter error notifications.
        const message = error instanceof SyntaxError ? 'Invalid proposal JSON' : error.message;
        vscode.window.showErrorMessage(`SecureForge: ${message}`);
      }
    }));
  }
}

export async function openReviewPayload(vscode, context, workspace, proposal, onApplied = () => {}) {
  const group = createReviewGroup(proposal);
  const entries = [];
  for (const review of group.files) {
    const source = await workspace.rawForProposal(review.path);
    if (source.hash !== review.baseSha256) throw new Error('Stale proposal: source file changed');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.resolve(workspace.root, review.path)));
    if (document.isDirty || sha256(document.getText()) !== review.baseSha256) {
      throw new Error('Save or undo existing editor changes before opening this proposal');
    }
    entries.push({ document, review, baseVersion: document.version });
  }
  // openTextDocument alone does not keep secondary files alive in VS Code.
  // Materialize each reviewed document as a non-preview editor tab so VS Code
  // does not silently close it while the human is considering the hunks.
  for (const { document } of entries) {
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: true,
    });
  }
  await vscode.window.showTextDocument(entries[0].document, {
    viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: true,
  });
  return showReview(vscode, context, workspace, entries, group, onApplied);
}

// Recheck against both the original on-disk SHA and the clean open buffer.
// A harmless editor-version increment can be safely refreshed, but changed
// or unsaved content is never rebased or silently overwritten.
export async function recheckReviewEntries({ vscode, workspace, entries, signal }) {
  if (!vscode.workspace.isTrusted) throw new Error('A trusted workspace is required');
  const validated = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    const { review } = entry;
    let document = entry.document;
    if (document.isClosed) {
      // Validate the source policy and original hash before asking VS Code
      // to open a closed path. The normal post-open checks still run below.
      const candidate = await workspace.rawForProposal(review.path);
      signal?.throwIfAborted();
      if (candidate.hash !== review.baseSha256) {
        throw new Error(`Cannot resume review: ${review.path} changed since proposal creation. Generate a new proposal for the current contents.`);
      }
      // A closed VS Code document is not proof of a changed file. Recover it
      // only after explicit Recheck, then verify the original bytes and
      // hashes exactly as for a still-open document.
      document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.resolve(workspace.root, review.path)));
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: true,
      });
      signal?.throwIfAborted();
    }
    if (document.isClosed) throw new Error(`Cannot resume review: ${review.path} could not be reopened. Prepare a new review.`);
    if (document.isDirty) {
      throw new Error(`Cannot resume review: ${review.path} has unsaved changes. Save or revert them before rechecking; regenerate the proposal if the content changed.`);
    }
    if (document.uri.scheme !== 'file' || document.uri.fsPath !== path.resolve(workspace.root, review.path)) {
      throw new Error('Cannot resume review: workspace document does not match the original proposal.');
    }
    const disk = await workspace.rawForProposal(review.path);
    signal?.throwIfAborted();
    if (disk.hash !== review.baseSha256 || document.isDirty ||
        sha256(document.getText()) !== review.baseSha256) {
      throw new Error(`Cannot resume review: ${review.path} changed since proposal creation. Generate a new proposal for the current contents.`);
    }
    validated.push({ entry, document, version: document.version });
  }
  // Validate the complete multi-file group before changing even one entry.
  // applyReviewGroup separately checks disk bytes and editor versions again.
  for (const { entry, document, version } of validated) {
    const { review } = entry;
    if (document.isClosed || document.isDirty || document.version !== version ||
        sha256(document.getText()) !== review.baseSha256) {
      throw new Error('A reviewed document changed while it was being rechecked. Retry after saving or reverting.');
    }
  }
  signal?.throwIfAborted();
  for (const { entry, document, version } of validated) {
    entry.document = document;
    entry.baseVersion = version;
  }
  return validated.length;
}

function showReview(vscode, context, workspace, entries, group, onApplied) {
  const panel = vscode.window.createWebviewPanel('secureforge.review', 'SecureForge Review', vscode.ViewColumn.Beside, {
    enableScripts: true,
    localResourceRoots: [],
    retainContextWhenHidden: true,
  });
  const controller = new AbortController();
  const hunks = group.files.flatMap(review => review.hunks.map(hunk => ({ ...hunk, path: review.path })));
  const decisions = Object.create(null);
  let status = 'pending';
  let appliedReceipt;
  let disposed = false;
  const knownIds = new Set(hunks.map(hunk => hunk.id));
  function send(message) {
    if (!disposed) panel.webview.postMessage(message);
  }
  const changes = vscode.workspace.onDidChangeTextDocument(event => {
    if (status === 'pending' && entries.some(entry => event.document === entry.document && entry.document.version !== entry.baseVersion)) {
      status = 'stale';
      send({ type: 'status', status, message: 'The document changed. Prepare a new proposal.' });
    }
  });
  const messages = panel.webview.onDidReceiveMessage(async message => {
    if (disposed || !message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      send({ type: 'review', path: group.files.map(file => file.path).join(', '),
        rationale: group.files.map(file => file.rationale).filter(Boolean).join('\n'), hunks });
      send({ type: 'status', status, message: 'Decide every hunk, then apply. Changes remain unsaved and support native Undo.' });
    } else if (message.type === 'decision' && status === 'pending' && knownIds.has(message.id) &&
        ['accept', 'reject'].includes(message.decision)) {
      decisions[message.id] = message.decision;
    } else if (message.type === 'acceptAll' && status === 'pending') {
      // Mark decisions only. This never invokes WorkspaceEdit or saves files.
      for (const hunk of hunks) decisions[hunk.id] = 'accept';
      send({ type: 'status', status, message: `Marked all ${hunks.length} hunks Accept. Review the choices, then explicitly apply.` });
    } else if (message.type === 'recheck' && ['stale', 'blocked'].includes(status)) {
      status = 'checking';
      send({ type: 'status', status, message: 'Checking unchanged source files and editor buffers…' });
      try {
        await recheckReviewEntries({ vscode, workspace, entries, signal: controller.signal });
        status = 'pending';
        send({ type: 'status', status, message: 'Source and clean editor buffers match the original proposal. Review decisions are retained; apply only when ready.' });
      } catch (error) {
        status = 'blocked';
        send({ type: 'status', status, message: error.message });
      }
    } else if (message.type === 'discard' && status === 'pending') {
      status = 'discarded';
      send({ type: 'status', status, message: 'Proposal discarded.' });
    } else if (message.type === 'apply' && status === 'pending') {
      if (hunks.some(hunk => !Object.hasOwn(decisions, hunk.id))) {
        send({ type: 'status', status, message: 'Accept or reject every hunk first.' });
        return;
      }
      status = 'applying';
      send({ type: 'status', status, message: 'Validating document and applying approved hunks…' });
      try {
        const result = await applyReviewGroup({ vscode, workspace, entries, decisions, signal: controller.signal });
        appliedReceipt = result;
        status = result.status;
        await onApplied({ group, decisions: { ...decisions }, result });
        send({ type: 'status', status, message: result.status === 'applied'
          ? `Applied ${result.accepted} hunk(s). Save when ready. Use Undo in the source editor to reverse the edit.`
          : 'All hunks rejected. The document was not edited.' });
      } catch (error) {
        status = 'blocked';
        send({ type: 'status', status, message: `${error.message} Click Recheck unchanged files below. If the file's contents changed, save or revert and generate a new proposal; SecureForge will not overwrite it.` });
      }
    } else if (message.type === 'undo' && status === 'applied') {
      status = 'undoing';
      try {
        await undoReviewGroup({ vscode, workspace, entries, receipt: appliedReceipt });
        status = 'undone';
        await onApplied({ group, decisions: { ...decisions }, result: { ...appliedReceipt, status: 'undone' } });
        send({ type: 'status', status, message: 'Accepted changes undone in the editor.' });
      } catch (error) {
        status = 'blocked';
        send({ type: 'status', status, message: error.message });
      }
    }
  });
  panel.onDidDispose(() => {
    disposed = true;
    controller.abort();
    changes.dispose();
    messages.dispose();
    void workspace.close();
  });
  context.subscriptions.push(panel);
  const installedVersion = vscode.extensions?.getExtension?.('secureforge.secureforge-review')?.packageJSON?.version;
  panel.webview.html = reviewHtml(installedVersion);
  return panel;
}

function reviewHtml(version) {
  const versionLabel = typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)
    ? version : 'development';
  const nonce = randomBytes(18).toString('base64');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SecureForge Review</title>
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
article { border: 1px solid var(--vscode-panel-border); padding: 12px; margin: 16px 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; background: var(--vscode-textCodeBlock-background); }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid transparent; padding: 7px 12px; margin: 4px; cursor: pointer; }
button[aria-pressed="true"] { outline: 2px solid var(--vscode-focusBorder); }
button:disabled { opacity: .5; cursor: default; }
.removed { border-left: 3px solid var(--vscode-gitDecoration-deletedResourceForeground); }
.added { border-left: 3px solid var(--vscode-gitDecoration-addedResourceForeground); }
#status { padding: 12px 0; }
</style></head><body>
<h1>Review proposed changes</h1><p id="extensionVersion">SecureForge extension ${versionLabel}</p><h2 id="path"></h2><p id="rationale"></p>
<p>Review each change independently. Apply affects the editor buffer. Save and Undo remain under your control.</p>
<div id="hunks"></div>
<div id="review-actions">
  <button id="acceptAll" disabled>Accept all hunks</button>
  <button id="apply" disabled>Apply accepted hunks</button>
  <button id="discard">Discard proposal</button>
  <button id="undo" disabled>Undo applied hunks</button>
  <button id="recheck" disabled hidden>Recheck unchanged files</button>
</div>
<p id="status" role="status" aria-live="polite">Loading proposal…</p>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const decisions = new Map();
let ids = [];
let state = 'pending';
const apply = document.getElementById('apply');
function update() {
  apply.disabled = state !== 'pending' || decisions.size !== ids.length || ids.length === 0;
  document.getElementById('acceptAll').disabled = state !== 'pending' || ids.length === 0;
  document.getElementById('discard').disabled = state !== 'pending';
  document.getElementById('undo').disabled = state !== 'applied';
  const recheck = document.getElementById('recheck');
  recheck.hidden = !['stale','blocked'].includes(state);
  recheck.disabled = !['stale','blocked'].includes(state);
  document.querySelectorAll('[data-decision]').forEach(button => { button.disabled = state !== 'pending'; });
}
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'review') {
    decisions.clear();
    ids = message.hunks.map(hunk => hunk.id);
    document.getElementById('path').textContent = message.path;
    document.getElementById('rationale').textContent = message.rationale;
    document.getElementById('hunks').replaceChildren();
    message.hunks.forEach((hunk, index) => {
      const article = document.createElement('article');
      const heading = document.createElement('h3');
      heading.textContent = hunk.path + ' · hunk ' + (index + 1) + ' · original line ' + hunk.startLine;
      article.append(heading);
      [['Original', hunk.oldText, 'removed'], ['Proposed', hunk.newText, 'added']].forEach(([label, text, kind]) => {
        const title = document.createElement('strong'); title.textContent = label;
        const code = document.createElement('pre'); code.textContent = text || '(empty)'; code.className = kind;
        article.append(title, code);
      });
      ['accept', 'reject'].forEach(decision => {
        const button = document.createElement('button');
        button.textContent = decision === 'accept' ? 'Accept' : 'Reject';
        button.dataset.decision = decision; button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => {
          if (state !== 'pending') return;
          decisions.set(hunk.id, decision);
          article.querySelectorAll('button').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
          vscode.postMessage({ type: 'decision', id: hunk.id, decision }); update();
        });
        article.append(button);
      });
      document.getElementById('hunks').append(article);
    });
  } else if (message.type === 'status') {
    state = message.status;
    document.getElementById('status').textContent = message.message;
  }
  update();
});
document.getElementById('acceptAll').addEventListener('click', () => {
  if (state !== 'pending' || ids.length === 0) return;
  ids.forEach(id => decisions.set(id, 'accept'));
  document.querySelectorAll('[data-decision]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.decision === 'accept'));
  });
  update();
  vscode.postMessage({ type: 'acceptAll' });
});
document.getElementById('recheck').addEventListener('click', () => {
  if (!['stale','blocked'].includes(state)) return;
  state = 'checking'; update();
  vscode.postMessage({ type: 'recheck' });
});
apply.addEventListener('click', () => {
  if (state !== 'pending' || apply.disabled) return;
  state = 'applying'; update(); vscode.postMessage({ type: 'apply' });
});
document.getElementById('discard').addEventListener('click', () => vscode.postMessage({ type: 'discard' }));
document.getElementById('undo').addEventListener('click', () => { state = 'undoing'; update(); vscode.postMessage({ type: 'undo' }); });
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
