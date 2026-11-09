# Hunk review milestone

## Inline editor review (default for Live Build)

The SecureForge sidebar accepts natural-language prompts. For a selection-specific
request, select code and run **SecureForge: Inline Edit Selection** (Cmd+Option+I on macOS).
Live Build and Inline Edit now open the **existing source file** in the normal VS Code
editor rather than a second review webview. Suggested hunks are highlighted,
with one compact clickable hint displaying **✅ Accept | ❌ Reject** at the end of
each affected line. The inlay-hint parts expose commands, but VS Code
can open a hover instead of executing them on an ordinary click.
Use **Cmd-click** on macOS (**Ctrl-click** on Windows/Linux) on the line-end
**✅ Accept | ❌ Reject** controls, or use the larger ordinary-click buttons
in the SecureForge chat sidebar. Hovering over either inlay hint also offers
clickable **✅ Accept | ❌ Reject** links alongside the full old/new code
preview. Each hover is rendered once rather than duplicated. The redundant
per-hunk CodeLens actions above every line are intentionally removed; that
space is reserved for Accept all, Reject all, Apply, Discard and Undo.
Nothing is applied until the user selects Apply.

The short line-end label is intentionally not preceded by a long code preview,
because VS Code truncates overly long inlay-hint groups. Once selected, a
decision changes to **✅ Accepted** or **❌ Rejected**.

Apply / Discard / Recheck / guarded Undo remain CodeLens actions above the first
change. Inlay hints inherit the user's VS Code theme and settings; the public
API cannot pin controls to the viewport's extreme right or assign separate
font size / bold styling to one extension's hints. For larger controls, set
`editor.inlayHints.fontSize` to `15` (affects all hints). Choosing Accept
or Reject does not edit the document; click **Apply accepted** in the editor
or in SecureForge chat after deciding every hunk.

The chat sidebar also shows each hunk's location, a short preview, and matching
Accept / Reject / Apply / Undo controls. Clicking a file location focuses the
source editor. **Review Proposal JSON** and **Open Two-Hunk Review Demo** also open editor-native
reviews through the same controller. The previous standalone review-webview
implementation remains available as an internal compatibility API and is no
longer the default UI.

Both surfaces share the same in-memory review decisions and the established
hash-validated, multi-file WorkspaceEdit transaction. The extension refuses
stale or dirty source buffers, does not modify disk until Save, and records
approval receipts for the Patch Passport. **Undo approved edit** is available
only while the editor and disk remain consistent with the applied receipt.
When external edits or Save/Restore interfere, use native Undo or inspect Git
rather than forcing a stale restore. The editor-native review never launches
the classic review tab automatically.

This local editor milestone consumes the existing pending v1 `get_proposal` payload, including `originalContent` and `proposedContent`. It derives line-level hunks without modifying the shared agent or MCP contracts.

## Review-all controls and Undo visibility

**Accept all** and **Reject all** are available above the first proposed hunk
and in the SecureForge sidebar. They set the decisions for every hunk in the
current batch but do not edit any buffer; the developer must still explicitly
select **Apply accepted**. If all hunks are rejected, the final action reads
**Finish rejection** and applies no edits.

The sidebar pins a compact review card above the prompt composer, rather than
leaving the Welcome illustration visible while its review is outside the scroll
area. A `ready` handshake retrieves the last review snapshot even when an
agent run or built-in demo staged the proposal before VS Code created the
sidebar view.

After Apply, the green preview highlighting and per-hunk decisions disappear
because the accepted source is now in the editor. The guarded **Undo approved
edit** command remains available as an editor CodeLens, a persistent
**Undo SecureForge edit** status-bar control, and a button in the sidebar
review card. Guarded Undo refuses to overwrite intervening edits or unexpected
disk changes. Successful Undo returns the original buffer without modifying
unrelated files. Saving is always a separate developer decision.

## Run in VS Code

1. Run `npm ci` in the repository root.
2. Open the repository root in desktop VS Code.
3. Press F5 and choose **Run SecureForge Review**.
4. In the Extension Development Host, open the command palette and run **SecureForge: Open Two-Hunk Review Demo**.
5. Accept the greeting change and reject the status change.
6. Click **Apply accepted hunks**. Only the greeting changes in the source editor buffer.
7. Focus the source editor and use native **Undo** to restore its original content. Use **Save** when you want accepted edits written to disk.

The demo uses `fixtures/review-demo.py` from the selected workspace and a synthetic proposal made through the real `ProposalStore`. It does not run a model. The review panel labels it as a local synthetic demo. Undo or restore the fixture before starting another demo if you saved edits.

## Review an agent proposal

Use **SecureForge: Build with TrueForge** for live delivery. Start local TrueForge 0.183.0 with `HOST=127.0.0.1 OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@0.183.0`. The exact localhost allowlist is required by this runtime's outbound guard to reach the workspace MCP bridge. Configure your model inside TrueForge and enter its FQN when prompted. The extension registers a temporary bearer-protected loopback MCP bridge, creates a real session, streams activity, handles TrueForge staging approval and opens returned proposals for separate human hunk review. The temporary connector is removed after the run.

Use **SecureForge: Review Proposal JSON** for a local full `get_proposal` response or `{id, proposals: [fullProposal, ...]}` group. Groups support up to eight existing files, using the upstream `propose_batch` contract. Choose the correct workspace folder if the window contains multiple roots. A `propose_edit` or `get_batch` summary alone is insufficient because it does not contain source and proposed text.

The extension validates the proposal's content hashes, current disk content, editor content and captured document version. It reuses the existing Workspace path/symlink restrictions. Every hunk needs an explicit decision. Applying is single-use. Closing or discarding a pending review does not apply it. Detected credentials in either source or proposed text block review. The panel inserts proposal text using DOM textContent under a nonce-based Content Security Policy.

Edits use VS Code WorkspaceEdit and native Undo. They remain unsaved until the developer saves. A stale proposal must be regenerated, even if the developer edited and later restored the original text.

## Scope and remaining integration

Existing-file groups use one WorkspaceEdit with a final check of every reviewed document. One stale member blocks the whole edit. The panel provides guarded Undo for the group, and VS Code native Undo remains available. Guarded Undo checks post-apply versions, hashes and disk state before restoring changes. New-file creation remains outside the current proposal contract.

**SecureForge: Cancel Agent Run** and the progress notification's Cancel action abort local consumption, request TrueForge session cancellation, discard pending proposals and close the bridge. Side-effecting requests are never automatically replayed. A failed or cancelled run cannot open a review. If server cancellation is unconfirmed, activity reports that limitation. Previously accepted edits remain under native Undo.

**SecureForge: Run Approved Verification** supports explicit Node test files and Python pytest files. It shows the executable, arguments, directory and timeout before execution. Shell execution, injected command flags and out-of-root files are rejected. Output is capped at 64 KiB and redacted, execution has a timeout, and Cancel terminates the process group. Save accepted editor changes before verifying them. Tests run with local user permissions and can execute repository code. The runner is a permission gate, not an OS sandbox. Model-provider environment variables are omitted from child environments.

Review bounds are 256 KiB per source/proposed text, a 250 ms diff budget, 10,000 maximum edit distance and 200 hunks. A JSON import is capped at 4 MiB. The diff dependency is pinned. Secret filtering is best effort. Filesystem restrictions cover proposal validation reads. WorkspaceEdit is an editor API, not an OS-level filesystem sandbox against another process racing a later Save.

## Verification

`npm test` includes deterministic hunk-selection and safe-apply regressions. Run `npm run test:editor` with desktop VS Code installed to exercise extension activation, accepted-only application, guarded Undo, Unicode/CRLF and stale-file handling in a real Extension Development Host. The runner uses an isolated VS Code profile and temporary fixtures. Reports and diagnostic profiles remain under ignored `.tmp/`. It never changes your normal VS Code profile. Set SECUREFORGE_CODE_PATH to the VS Code CLI executable if it is installed outside the default macOS location or Linux PATH. Tests currently support macOS/Linux, matching the existing Workspace implementation.

Manual UI verification also exercised the demo command, visible old/new hunk previews, Accept on the first hunk, Reject on the second, Apply and native Undo. Official Task A and production-model behavior remain separate acceptance gates.

`npm run test:editor:wire` additionally exercises a real TrueForge runtime/SDK/MCP session into the editor using a deterministic local OpenAI-compatible inference fixture. It registers and removes a temporary fixture provider. This proves protocol and handoff behavior. A user-selected production model still needs separate verification. The runtime must be running with the exact localhost allowlist above.
