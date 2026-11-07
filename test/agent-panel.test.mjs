import test from 'node:test';
import assert from 'node:assert/strict';
import { Script, runInNewContext } from 'node:vm';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerAgentPanel } from '../extension/agent-panel.mjs';

test('agent panel emits valid script, bounds tasks and surfaces run failures', async () => {
  let open;
  let receive;
  let provider;
  let options;
  const commands = [];
  const messages = [];
  const panel = {
    onDidDispose() {},
    webview: {
      postMessage: message => messages.push(message),
      onDidReceiveMessage: handler => { receive = handler; },
    },
  };
  const vscode = {
    commands: {
      registerCommand: (_name, handler) => { open = handler; return {}; },
      executeCommand: async name => { commands.push(name); },
    },
    window: {
      registerWebviewViewProvider: (_id, item, opts) => { provider = item; options = opts; return {}; },
      showOpenDialog: async () => [{ scheme: 'file', fsPath: '/tmp/flask-correct' }],
    },
    workspace: { workspaceFolders: [{ uri: { fsPath: '/tmp/flask' } }] },
  };
  let runs = 0;
  let cancels = 0;
  registerAgentPanel(vscode, { subscriptions: [] }, {
    subscribe: () => ({ dispose() {} }),
    run: async () => { runs++; throw new Error('Model unavailable'); },
    cancel: async () => { cancels++; },
  });
  await open();
  assert.deepEqual(commands, ['secureforge.agentSidebar.focus']);
  assert.equal(options.webviewOptions.retainContextWhenHidden, true);
  provider.resolveWebviewView(panel);
  assert.equal(panel.webview.options.enableScripts, true);
  assert.match(panel.webview.html, /\/tmp\/flask/);
  const script = panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Script(script));
  assert.match(panel.webview.html, /Ask SecureForge/);
  assert.match(panel.webview.html, /Repository-aware coding assistant/);
  assert.match(panel.webview.html, /SecureForge shield logo/);
  assert.match(panel.webview.html, /id="dock"/);
  assert.match(panel.webview.html, /id="file"/);
  assert.match(panel.webview.html, /id="symbol"/);
  assert.match(panel.webview.html, /id="run"/);
  assert.match(panel.webview.html, /id="technical"/);
  assert.match(panel.webview.html, /reviewReady/);
  assert.doesNotMatch(panel.webview.html, /Build with confidence|Find and propose changes/);
  await receive({ type: 'run', task: 'x'.repeat(20001) });
  assert.equal(runs, 0);
  await receive({ type: 'run', task: 'Update docstring' });
  assert.equal(runs, 1);
  assert.match(messages.at(-1).message, /Model unavailable/);
  await receive({ type: 'cancel' });
  assert.equal(cancels, 1);
  await receive({ type: 'verify' });
  assert.equal(commands.at(-1), 'secureforge.runVerification');
  await receive({ type: 'openRecent' });
  assert.equal(commands.at(-1), 'workbench.action.openRecent');
  await receive({ type: 'openFolder' });
  assert.equal(commands.at(-1), 'vscode.openFolder');
  vscode.workspace.workspaceFolders[0].uri.fsPath = '/tmp/<img src=x>&research';
  provider.resolveWebviewView(panel);
  assert.match(panel.webview.html, /title="\/tmp\/&lt;img src=x&gt;&amp;research"/);
  assert.match(panel.webview.html, /<span>&lt;img src=x&gt;&amp;research<\/span>/);
  assert.doesNotMatch(panel.webview.html, /<img src=x>/);
});

test('sidebar defaults to the right, and minimal composer dispatches tasks safely', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.contributes.viewsContainers.secondarySidebar[0].id, 'secureforge');
  assert.equal(manifest.contributes.views.secureforge[0].id, 'secureforge.agentSidebar');
  assert.equal(manifest.contributes.viewsContainers.activitybar, undefined);

  let provider;
  const panel = { onDidDispose() {}, webview: { postMessage() {}, onDidReceiveMessage() {} } };
  registerAgentPanel({
    commands: { registerCommand: () => ({ dispose() {} }) },
    window: { registerWebviewViewProvider: (_, value) => { provider = value; return { dispose() {} }; } },
    workspace: { workspaceFolders: [{ uri: { fsPath: '/tmp/flask' } }] },
  }, { subscriptions: [] }, { subscribe: () => ({ dispose() {} }), run() {}, cancel() {} });
  provider.resolveWebviewView(panel);
  const html = panel.webview.html;
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];

  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, textContent: '', value: '', hidden: false, disabled: false, isConnected: true, children: [], scrollHeight: 0,
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; for (const node of nodes) node.isConnected = true; },
      remove() { this.isConnected = false; },
      focus() {},
    });
    return elements.get(id);
  }
  const posted = [];
  const listeners = {};
  runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: value => posted.push(value) }),
    document: { getElementById: element, createElement: () => element('new-' + elements.size),
      querySelector: selector => selector === '.folder span' ? element('workspace-label') : null },
    window: { addEventListener: (kind, fn) => { listeners[kind] = fn; } },
  });
  element('task').value = 'Fix the parser';
  element('run').onclick();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'run');
  assert.equal(posted[0].task, 'Fix the parser');
  assert.equal(element('task').value, '');

  listeners.message({ data: { type: 'status', message: 'Running', running: true } });
  assert.equal(element('run').disabled, true);
  assert.equal(element('cancel').hidden, false);
  listeners.message({ data: { type: 'reviewReady', fileCount: 2 } });
  listeners.message({ data: { type: 'status', message: 'Done', running: false } });
  assert.equal(element('run').disabled, false);
  assert.match(element('status').textContent, /Review changes/);
  listeners.message({ data: { type: 'reviewResult', status: 'applied', accepted: 2 } });
  assert.match(element('status').textContent, /Save and verify/);
  const reviewMessage = element('thread').children.at(-1);
  const verifyButton = reviewMessage.children.at(-1);
  assert.equal(verifyButton.textContent, 'Run tests (save files first)');
  verifyButton.onclick();
  assert.equal(posted.at(-1).type, 'verify');
  listeners.message({ data: { type: 'verificationResult', executed: true, status: 'passed', fileCount: 2 } });
  assert.equal(element('status').textContent, 'Tests passed');
  listeners.message({ data: { type: 'workspace', name: 'correct-flask-project' } });
  assert.equal(element('workspace-label').textContent, 'correct-flask-project');
  listeners.message({ data: { type: 'noProposal', message: 'The model cannot find the requested source.' } });
  assert.equal(element('status').textContent, 'No changes proposed');
  listeners.message({ data: { type: 'workspaceMismatch', message: 'Flask source is absent. No model was called.' } });
  assert.equal(element('status').textContent, 'Wrong workspace · No model call');
  const lastMessage = element('thread').children.at(-1);
  const recentButton = lastMessage.children.at(-2);
  const browseButton = lastMessage.children.at(-1);
  assert.equal(recentButton.textContent, 'Recent projects');
  assert.equal(browseButton.textContent, 'Browse folders');
  recentButton.onclick();
  assert.equal(posted.at(-1).type, 'openRecent');
  browseButton.onclick();
  assert.equal(posted.at(-1).type, 'openFolder');

  listeners.message({ data: {
    type: 'workspaceMismatch', code: 'FLASK_PACKAGE_SUBFOLDER',
    message: 'You opened only src/flask. Open the repository root.',
  } });
  const packageMessage = element('thread').children.at(-1);
  assert.equal(packageMessage.children.at(-3).textContent, 'Open Flask repository root');
  packageMessage.children.at(-3).onclick();
  assert.equal(posted.at(-1).type, 'openFlaskRoot');
});

test('Flask root button validates project structure and requires approval before opening', async t => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'sf-flask-project-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const packageFolder = path.join(repo, 'src', 'flask');
  await mkdir(packageFolder, { recursive: true });
  await mkdir(path.join(repo, 'tests'));
  for (const file of ['pyproject.toml', 'src/flask/helpers.py', 'tests/test_helpers.py']) {
    await writeFile(path.join(repo, file), 'fixture\n');
  }
  let receive;
  let provider;
  const commands = [];
  const vscode = {
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
    workspace: { workspaceFolders: [{ uri: { scheme: 'file', fsPath: packageFolder } }] },
    commands: {
      registerCommand: () => ({ dispose() {} }),
      executeCommand: async (...args) => { commands.push(args); },
    },
    window: {
      registerWebviewViewProvider: (_id, item) => { provider = item; return { dispose() {} }; },
      showInformationMessage: async () => 'Open Flask root',
      showWarningMessage: async () => { throw new Error('Unexpected warning'); },
    },
  };
  registerAgentPanel(vscode, { subscriptions: [] }, { subscribe: () => ({ dispose() {} }) });
  provider.resolveWebviewView({
    onDidDispose() {},
    webview: { postMessage() {}, onDidReceiveMessage: handler => { receive = handler; } },
  });
  await receive({ type: 'openFlaskRoot' });
  const last = commands.at(-1);
  assert.equal(last[0], 'vscode.openFolder');
  assert.equal(last[1].fsPath, repo);
  assert.equal(last[2].forceNewWindow, true);
});
