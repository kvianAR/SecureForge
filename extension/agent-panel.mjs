import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { lstat } from 'node:fs/promises';

export function registerAgentPanel(vscode, context, actions) {
  function attach(view) {
    const panel = view;
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    const nonce = randomBytes(16).toString('hex');
    let running = false;
    let disposed = false;
    const subscription = actions.subscribe(event => { if (!disposed) panel.webview.postMessage(event); });
    panel.onDidDispose(() => { disposed = true; subscription.dispose(); if (running) void actions.cancel(); });
    panel.webview.onDidReceiveMessage(async message => {
      if (disposed || !message || typeof message !== 'object') return;
      if (message.type === 'ready') {
        // A demo may stage edits before the secondary sidebar webview loads.
        const snapshot = actions.currentReviewState?.();
        if (snapshot) panel.webview.postMessage(snapshot);
        return;
      }
      if (message.type === 'cancel') { await actions.cancel(); return; }
      if (message.type === 'verify') {
        if (!running) await vscode.commands.executeCommand('secureforge.runVerification');
        return;
      }
      if (message.type === 'reviewAction') {
        if (!['accept', 'reject', 'acceptAll', 'rejectAll', 'apply', 'undo', 'discard', 'recheck', 'focus'].includes(message.action)) return;
        try { await actions.reviewAction?.(message.action, message.id); }
        catch (error) {
          if (!disposed) panel.webview.postMessage({ type: 'reviewError', message: String(error.message || 'Review action failed').slice(0, 300) });
        }
        return;
      }
      if (message.type === 'openFlaskRoot') {
        // The user must request this action. Validate the expected repository
        // files before opening a folder two levels above the Python package.
        const folders = vscode.workspace?.workspaceFolders?.filter(item => item.uri?.scheme === 'file');
        if (folders?.length !== 1) return;
        const root = path.resolve(folders[0].uri.fsPath, '..', '..');
        try {
          for (const relative of ['pyproject.toml', 'src/flask/helpers.py', 'tests/test_helpers.py']) {
            const metadata = await lstat(path.join(root, relative));
            if (!metadata.isFile()) throw new Error('Not a regular file');
          }
        } catch {
          await vscode.window.showWarningMessage(
            'The Flask repository root could not be verified. Choose Browse folders to locate the folder containing pyproject.toml, src/ and tests.');
          return;
        }
        const approval = await vscode.window.showInformationMessage(
          `Open Flask repository root: ${root}?`, { modal: true }, 'Open Flask root');
        if (approval === 'Open Flask root') {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: true });
        }
        return;
      }
      if (message.type === 'openRecent') {
        await vscode.commands.executeCommand('workbench.action.openRecent');
        return;
      }
      if (message.type === 'openFolder') {
        const folders = await vscode.window.showOpenDialog({
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          openLabel: 'Open project folder',
        });
        if (folders?.[0]?.scheme === 'file') {
          await vscode.commands.executeCommand('vscode.openFolder', folders[0], { forceNewWindow: true });
        }
        return;
      }
      if (message.type === 'attachFile' || message.type === 'attachSymbol') {
        const mention = await (message.type === 'attachFile' ? actions.attachFile() : actions.attachSymbol());
        if (mention && !disposed) panel.webview.postMessage({ type: 'attachment', mention });
        return;
      }
      if (message.type !== 'run' || running || typeof message.task !== 'string' || !message.task.trim() || message.task.length > 20000) return;
      running = true;
      panel.webview.postMessage({ type: 'status', message: 'Running', running: true });
      let finalStatus = 'Run completed. Inspect the chat for its outcome.';
      try {
        const result = await actions.run(message.task);
        if (result?.status === 'cancelled') finalStatus = 'Cancelled. No files were changed.';
        else if (result?.status === 'no_proposal') finalStatus = 'No changes proposed.';
        else if (result?.status === 'workspace_mismatch') finalStatus = 'Open the correct project folder to continue.';
        else if (result?.status === 'review') finalStatus = 'Review the proposed changes in the editor.';
      } catch (error) { finalStatus = error.message; }
      finally {
        running = false;
        if (!disposed) panel.webview.postMessage({ type: 'status', message: finalStatus, running: false });
      }
    });
    const workspaceLabel = (vscode.workspace?.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0].uri.fsPath : 'Choose your target project when you run Build');
    const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SecureForge</title>
<style nonce="${nonce}">
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;overflow:hidden;background:var(--vscode-sideBar-background);color:var(--vscode-foreground);font:13px/1.5 var(--vscode-font-family)}
button{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit}
button:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
button:disabled{opacity:.45;cursor:default}
header{height:43px;flex-shrink:0;padding:0 12px 0 13px;display:flex;align-items:center;gap:9px;border-bottom:1px solid var(--vscode-panel-border)}
header strong{font-size:13px;font-weight:650}
header svg{width:21px;height:21px}
#new{margin-left:auto;width:30px;height:30px;border-radius:7px;display:grid;place-items:center}
#new:hover,.iconbtn:hover{background:var(--vscode-toolbar-hoverBackground)}
#new svg{width:17px;height:17px}
#thread{min-height:0;flex:1;overflow-y:auto;padding:16px 14px;scrollbar-width:thin}
#welcome{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:10px;padding:0 8px 54px}
#welcome svg{width:80px;height:80px}
#welcome h1{font-size:23px;font-weight:650;letter-spacing:-.5px;margin:0}
#welcome p{font-size:13px;color:var(--vscode-descriptionForeground);margin:0;max-width:270px}
.message{margin:11px 0;padding:11px 12px;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:11px;border:1px solid var(--vscode-panel-border);font-size:13px}
.message.user{margin-left:24px;background:var(--vscode-textBlockQuote-background)}
.message.agent{margin-right:14px;background:var(--vscode-editor-background)}
.message .sender{font-size:11px;font-weight:600;margin-bottom:4px;color:var(--vscode-descriptionForeground)}
#dock{flex-shrink:0;padding:0 11px 13px;background:var(--vscode-sideBar-background)}
#reviewMount{max-height:42vh;min-height:0;overflow:auto;margin:0 0 10px;border-bottom:1px solid var(--vscode-panel-border);padding:2px 0 10px;scrollbar-width:thin}
#reviewMount[hidden]{display:none!important}
#status{font-size:11px;color:var(--vscode-descriptionForeground);min-height:16px;margin:0 3px 7px;overflow-wrap:anywhere}
.composer{border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:12px;background:var(--vscode-input-background);padding:9px 10px 8px}
textarea{display:block;border:0!important;outline:none!important;resize:vertical;min-height:43px;max-height:150px;width:100%;background:transparent;color:var(--vscode-input-foreground);font:13px/1.5 var(--vscode-font-family);padding:2px 0}
textarea::placeholder{color:var(--vscode-input-placeholderForeground)}
.toolbar{display:flex;align-items:center;gap:3px;min-width:0;margin-top:6px}
.iconbtn{display:grid;place-items:center;width:30px;height:30px;border-radius:7px;flex-shrink:0}
.iconbtn svg{width:16px;height:16px;stroke:currentColor}
.spacer{flex:1}
.folder{display:flex;align-items:center;gap:5px;min-width:0;max-width:42%;color:var(--vscode-descriptionForeground);font-size:11px;white-space:nowrap}
.folder svg{width:15px;height:15px;flex-shrink:0}
.folder span{overflow:hidden;text-overflow:ellipsis}
.send{background:var(--vscode-button-background);color:var(--vscode-button-foreground);width:31px;height:31px;border-radius:8px;display:grid;place-items:center;flex-shrink:0}
.send:hover{background:var(--vscode-button-hoverBackground)}
.send svg{width:17px;height:17px}
#cancel{color:var(--vscode-errorForeground);font-size:11px;width:auto;padding:0 7px}
#technical{margin:9px 0 0;padding:10px 4px 0;border-top:1px solid var(--vscode-panel-border);max-height:180px;overflow:auto}
#technical summary{cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground)}
.change-folder{margin-top:10px;padding:7px 10px;border-radius:7px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font-weight:600}
.inline-review{border:1px solid var(--vscode-panel-border);border-radius:10px;margin:0;padding:10px;background:var(--vscode-editor-background);font-size:12px}
.inline-review .title{font-weight:650;margin-bottom:4px}
.inline-review .hint{color:var(--vscode-descriptionForeground);font-size:11px;margin-bottom:7px}
.inline-review .hunk{padding:7px 0;border-top:1px solid var(--vscode-panel-border)}
.inline-review .file{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--vscode-editor-font-family);font-size:11px;color:var(--vscode-descriptionForeground)}
.inline-review .preview{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:3px 0;color:var(--vscode-editorGhostText-foreground,var(--vscode-descriptionForeground))}
.inline-review .actions{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:3px}
.inline-review .small{font-size:13px;font-weight:750;line-height:1.35;min-height:28px;padding:4px 9px;border:1px solid var(--vscode-panel-border);border-radius:7px}
.inline-review .small.accept{color:var(--vscode-testing-iconPassed,#36b878);border-color:currentColor}
.inline-review .small.reject{color:var(--vscode-testing-iconFailed,#f06565);border-color:currentColor}
.inline-review .small.accept.selected{background:var(--vscode-testing-iconPassed,#267a51);color:var(--vscode-editor-background)}
.inline-review .small.reject.selected{background:var(--vscode-testing-iconFailed,#a83d43);color:var(--vscode-editor-background)}
.inline-review .small:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground)}
.inline-review .small.selected{border-color:var(--vscode-focusBorder);color:var(--vscode-textLink-foreground)}
.inline-review .small.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
#technical pre{max-height:125px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}
[hidden]{display:none!important}
@media(max-width:300px){header{padding-left:10px}#thread{padding:12px}#dock{padding:0 7px 9px}.folder{max-width:30%}}
</style></head><body>
<header>
<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M32 5 53 14v20c0 12-8 20-21 25C19 54 11 46 11 34V14L32 5Z" stroke="#73B9FA" stroke-width="4" stroke-linejoin="round"/><path d="m26 24-8 8 8 8m12-16 8 8-8 8m-11-23-6 30" stroke="#73B9FA" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
<strong>SecureForge</strong>
<button id="new" title="New conversation" aria-label="New conversation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 5v14M5 12h14"/></svg></button>
</header>
<main id="thread" role="log" aria-label="SecureForge conversation" aria-live="polite">
<section id="welcome">
<svg viewBox="0 0 96 96" role="img" aria-label="SecureForge shield logo" fill="none"><defs><linearGradient id="brand" x1="15" y1="20" x2="80" y2="82" gradientUnits="userSpaceOnUse"><stop stop-color="#85D5FE"/><stop offset="1" stop-color="#6B8CF8"/></linearGradient></defs><path d="M48 8 77 21v26c0 18-12 29-29 39C31 76 19 65 19 47V21L48 8Z" stroke="url(#brand)" stroke-width="4.8" stroke-linejoin="round"/><path d="m39 35-12 13 12 13m18-26 12 13-12 13m-9-31-7 35" stroke="url(#brand)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
<h1>SecureForge</h1>
<p>Repository-aware coding assistant</p>
</section>
</main>
<footer id="dock">
<section id="reviewMount" aria-label="SecureForge review decisions" hidden></section>
<div id="status" role="status" aria-live="polite">Ready · All edits require approval</div>
<div class="composer"><textarea id="task" rows="2" maxlength="20000" aria-label="Ask SecureForge" placeholder="Ask SecureForge…"></textarea>
<div class="toolbar">
<button class="iconbtn" id="file" title="Attach a file" aria-label="Attach file"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5 13.5 7a3.5 3.5 0 0 1 5 5L10 20.5a5.5 5.5 0 0 1-8-8l9-9"/></svg></button>
<button class="iconbtn" id="symbol" title="Add symbol context" aria-label="Attach symbol"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-6 9 6-9 6-9-6Zm0 4 9 6 9-6M3 17l9 5 9-5"/></svg></button>
<span class="spacer"></span>
<span class="folder" title="${escapeHtml(workspaceLabel)}" aria-label="Current workspace"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h6l2 2h10v11H3z"/></svg><span>${escapeHtml(workspaceLabel.split(/[\\/]/).filter(Boolean).at(-1) || 'Workspace')}</span></span>
<button class="iconbtn" id="cancel" title="Stop run" aria-label="Stop run" hidden>Stop</button>
<button class="send" id="run" title="Send task" aria-label="Send task"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 13 0m-6-6 6 6-6 6"/></svg></button>
</div></div>
<details id="technical"><summary>Activity and retrieved files</summary><div id="context"></div><pre id="activity"></pre></details>
</footer>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
const task=document.getElementById('task'),thread=document.getElementById('thread'),welcome=document.getElementById('welcome'),run=document.getElementById('run'),cancel=document.getElementById('cancel'),status=document.getElementById('status'),reviewMount=document.getElementById('reviewMount');
let busy=false,review=false,hasReply=false,reviewCard;
function message(role,value){if(welcome.isConnected)welcome.remove();const box=document.createElement('div');box.className='message '+role;const head=document.createElement('div');head.className='sender';head.textContent=role==='user'?'You':'SecureForge';const body=document.createElement('div');body.textContent=String(value||'').slice(0,4000);box.append(head,body);thread.append(box);thread.scrollTop=thread.scrollHeight;return box;}
function drawReview(data){
 if(reviewCard)reviewCard.remove();
 reviewCard=undefined;
 reviewMount.replaceChildren();
 if(!Array.isArray(data.hunks)||!data.hunks.length){
  reviewMount.hidden=true;
  if(data.status==='discarded')status.textContent='Review discarded · No files changed';
  return;
 }
 // Keep review decisions visible beside the composer, including for demos
 // opened before the sidebar webview loaded.
 if(welcome.isConnected)welcome.remove();
 review=true;
 reviewMount.hidden=false;
 status.textContent=(data.message||'Review suggested changes in the source editor.').slice(0,180);
 const card=document.createElement('section');card.className='inline-review';
 const heading=document.createElement('div');heading.className='title';heading.textContent='Review edits · '+data.hunks.length+' hunk(s)';
 const hint=document.createElement('div');hint.className='hint';
 hint.textContent=(data.message||'Select Accept or Reject for each change.').slice(0,300);
 card.append(heading,hint);
 const post=(action,id)=>vscode.postMessage({type:'reviewAction',action,id});
 function small(label,action,id,selected=false,primary=false){
  const button=document.createElement('button');button.className='small'+(selected?' selected':'')+(primary?' primary':'')+
    (action==='accept'||action==='reject'?' '+action:'');
  button.textContent=label;button.onclick=()=>post(action,id);return button;
 }
 for(const item of data.hunks.slice(0,200)){
  const hunk=document.createElement('div');hunk.className='hunk';
  const file=document.createElement('button');file.className='file';file.textContent=item.path+':'+item.line;file.title='Open location in editor';file.onclick=()=>post('focus',item.id);
  const snippet=document.createElement('span');snippet.className='preview';snippet.textContent=item.preview||'Change';
  const actions=document.createElement('div');actions.className='actions';
  if(data.status==='pending'){
   actions.append(small('✓ Accept','accept',item.id,item.decision==='accept'),
     small('✕ Reject','reject',item.id,item.decision==='reject'));
  }else{
   const state=document.createElement('span');state.className='hint';
   state.textContent=item.decision==='accept'?'Accepted':item.decision==='reject'?'Rejected':data.status;
   actions.append(state);
  }
  hunk.append(file,snippet,actions);card.append(hunk);
 }
 const foot=document.createElement('div');foot.className='actions';
 if(data.status==='pending'){
  foot.append(small('✓ Accept all','acceptAll'),small('✕ Reject all','rejectAll'));
  const complete=data.decided===data.hunks.length;
  const apply=small(data.accepted===0&&complete?'Finish rejection':'Apply accepted','apply',undefined,false,true);
  apply.disabled=!complete;
  foot.append(apply,small('Discard','discard'));
 }else if(data.status==='applied'){
  foot.append(small('↶ Undo approved edit','undo',undefined,false,true));
 }else if(data.status==='stale'||data.status==='blocked'){
  foot.append(small('Recheck unchanged','recheck'));
 }
 card.append(foot);reviewMount.append(card);reviewCard=card;
}
function submit(){const text=task.value.trim();if(!text||busy)return;review=false;hasReply=false;message('user',text);task.value='';status.textContent='Reading your project…';vscode.postMessage({type:'run',task:text});}
run.onclick=submit;
task.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submit();}};
cancel.onclick=()=>vscode.postMessage({type:'cancel'});
document.getElementById('file').onclick=()=>vscode.postMessage({type:'attachFile'});
document.getElementById('symbol').onclick=()=>vscode.postMessage({type:'attachSymbol'});
document.getElementById('new').onclick=()=>{if(busy)return;thread.replaceChildren(welcome);task.value='';status.textContent='Ready · All edits require approval';review=false;task.focus();};
window.addEventListener('message',event=>{const data=event.data;if(!data||typeof data!=='object')return;
 if(data.type==='status'){
   busy=Boolean(data.running);run.disabled=busy;document.getElementById('file').disabled=busy;document.getElementById('symbol').disabled=busy;cancel.hidden=!busy;
   if(busy){status.textContent='Working on your code…';}
   else{if(review)status.textContent='Review changes in the editor';else if(!hasReply){status.textContent=data.message;message('agent',data.message);hasReply=true;}}
 }
 if(data.type==='inlineReviewState'){drawReview(data);}
  if(data.type==='reviewError'){message('agent',String(data.message||'Review action failed').slice(0,300));}
  if(data.type==='reviewReady'){review=true;hasReply=true;const count=Number.isInteger(data.fileCount)?data.fileCount:0;const note=typeof data.message==='string'&&data.message.trim()?data.message.trim().slice(0,3000):'Review the proposed edits in the editor before applying them.';message('agent','Proposed changes in '+count+' file(s). Nothing has been applied.\\n\\n'+note);status.textContent='Review changes in the editor';}
 if(data.type==='workspaceMismatch'){
   hasReply=true;
   const box=message('agent',String(data.message||'This task belongs to another project.').slice(0,1200));
   if(data.code==='FLASK_PACKAGE_SUBFOLDER'){
     const rootButton=document.createElement('button');
     rootButton.className='change-folder';
     rootButton.textContent='Open Flask repository root';
     rootButton.onclick=()=>vscode.postMessage({type:'openFlaskRoot'});
     box.append(rootButton);
   }
   const recent=document.createElement('button');
   recent.className='change-folder';
   recent.textContent='Recent projects';
   recent.onclick=()=>vscode.postMessage({type:'openRecent'});
   const browse=document.createElement('button');
   browse.className='change-folder';
   browse.textContent='Browse folders';
   browse.onclick=()=>vscode.postMessage({type:'openFolder'});
   box.append(recent,browse);
   status.textContent='Wrong workspace · No model call';
 }
 if(data.type==='noProposal'){hasReply=true;const note=typeof data.message==='string'&&data.message.trim()?data.message.trim().slice(0,3000):'The run completed without proposing changes. Your files are unchanged.';message('agent',note);status.textContent='No changes proposed';}
 if(data.type==='reviewResult'){
   review=false;hasReply=true;
   const count=Number.isInteger(data.accepted)?data.accepted:0;
   const note=data.status==='applied'?'Applied '+count+' approved hunk(s) to the editor. Save the files and run tests before committing.':
     data.status==='undone'?'Approved changes were undone in the editor.':
     'No changes applied; all hunks were rejected.';
   const box=message('agent',note);
   if(data.status==='applied'){
     const button=document.createElement('button');
     button.className='change-folder';
     button.textContent='Run tests (save files first)';
     button.onclick=()=>vscode.postMessage({type:'verify'});
     box.append(button);
   }
   status.textContent=data.status==='applied'?'Save and verify your changes':'Review complete';
 }
 if(data.type==='verificationResult'){
   const n=Number.isInteger(data.fileCount)?data.fileCount:0;
   const description=data.executed===true&&data.status==='passed'?
      'Verification passed for '+n+' selected test file(s). Review the diff before committing.':
      data.executed===true&&data.status==='failed'?
      'Verification failed. Open SecureForge Activity in the Output panel for details.':
      data.status==='denied'?
      'Verification was not approved. No tests were executed.':
      data.status==='timed_out'?'Verification timed out. Inspect SecureForge Activity for details.':
      data.status==='cancelled'?'Verification was cancelled.':
      'Verification did not pass. Inspect SecureForge Activity for details.';
   message('agent',description);
   status.textContent=data.executed===true&&data.status==='passed'?'Tests passed':'Verification incomplete';
 }
 if(data.type==='workspace'){
   const label=document.querySelector('.folder span');
   if(label&&typeof data.name==='string')label.textContent=data.name;
 }
 if(data.type==='error'){hasReply=true;message('agent',data.message);status.textContent=data.message;}
 if(data.type==='attachment'){task.value+=(task.value?' ':'')+data.mention;task.focus();}
 if(data.type==='context')document.getElementById('context').textContent=data.summary;
 if(data.type==='activity'){const line=String(data.text||'');const log=document.getElementById('activity');log.textContent=(log.textContent+line+'\\n').slice(-32000);if(busy&&/discover_repository: started/.test(line))status.textContent='Finding relevant files…';if(busy&&/propose_(patch_batch|batch|edit): started/.test(line))status.textContent='Preparing changes…';}
});
vscode.postMessage({type:'ready'});
</script></body></html>`;
  }
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(
    'secureforge.agentSidebar',
    { resolveWebviewView: attach },
    { webviewOptions: { retainContextWhenHidden: true } },
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    'secureforge.openAgentPanel',
    () => vscode.commands.executeCommand('secureforge.agentSidebar.focus'),
  ));
}
