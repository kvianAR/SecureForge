# Security review, fix evidence and Patch Passport

## Commands

Open the repository in desktop VS Code, run `npm ci`, then press F5 with **Run SecureForge Review**. The Extension Development Host exposes these commands:

- **SecureForge: Build with TrueForge** sends the request through the configured local TrueForge runtime, registers a temporary authenticated MCP bridge, handles staging approvals and opens returned single-file or batch proposals.
- **SecureForge: Review Proposal JSON** imports full v1 proposals or a group containing full proposals.
- **SecureForge: Run Approved Verification** requests explicit Node test or Python pytest execution.
- **SecureForge: Cancel Agent Run** cancels the active local agent workflow and requests server cancellation.
- **SecureForge: Security Review** runs a read-only review of the active saved file or a bounded workspace scope.
- **SecureForge: Start Owned Security Lab** creates disposable positive and negative fixtures in a fresh private operating-system temporary directory and offers the controlled repair flow.
- **SecureForge: Verify Security Fix** runs the saved lab regression after a reviewed fix.
- **SecureForge: Export Patch Passport** saves recorded patch decisions, command receipts, findings, proof links and limitations as local JSON.

All models are configured inside TrueForge. See [review and runtime setup](REVIEW.md) for the local runtime command and localhost allowlist. Production-provider validation requires the team's own configured provider. The test fixture uses a temporary deterministic OpenAI-compatible provider and removes it afterward.

## Read-only review and evidence

Four narrow checks cover joined filenames reaching filesystem reads, interpolated shell commands, interpolated database execution and supported credential literals. Results carry a rule ID, relative path, line, source hash, redacted evidence, impact, confidence, verification state and limitations. These are pattern-based candidates. Caller trust, authorization requirements and surrounding safeguards still require inspection.

The review uses existing Workspace path, symlink, encoding and file-size controls. It reads up to 250 files and 2 MiB in aggregate, and returns up to 100 findings. Reports list reviewed hashes, skipped paths and coverage limits. Cancellation aborts the review. A result with zero candidates describes only this bounded scope and these supported checks.

The user selects a finding and chooses **Open Evidence**, **Prepare Fix** or **Show Report**. Prepare Fix uses an exact template only for the owned traversal fixture. Other candidates can be investigated through the TrueForge Build workflow, followed by normal patch review.

## Owned security lab

1. Run **Start Owned Security Lab** in a trusted local workspace.
2. Approve the displayed baseline command. It runs an explicit `regression.test.mjs` file with the Node TAP reporter.
3. The baseline must demonstrate the expected parent-directory failure and a working permitted-note case. The separately reviewed safe control must have no supported finding.
4. Choose **Prepare Fix**. This creates an in-memory proposal and opens the regular review panel.
5. Accept or reject its hunks. Apply accepted changes and save the fixture file.
6. Run **Verify Security Fix**, then approve the post-fix command.
7. Export the Patch Passport.

The regression covers permitted access, parent-directory traversal, absolute outside paths and outside symlinks. A proof links the unchanged test hash, baseline and post-fix receipt IDs, target hashes, finding ID and approved proposal ID. It requires a supported baseline failure and four passing post-fix cases. Missing evidence yields an inconclusive result. Concurrent path replacement is outside this controlled fixture.

The vulnerable sample intentionally demonstrates a local flaw. It operates only on temporary fixture data. Product workspace reads retain their existing descriptor-based protections.

## Applying, undoing and verifying

Groups contain up to eight existing files and reuse Shubhaang's upstream BatchProposalStore contract. The review layer derives hunks without changing agent contracts. Every hunk requires a decision. All files are checked before one WorkspaceEdit applies accepted hunks. A stale member blocks the batch. Changes remain in editor buffers until Save.

The panel's **Undo applied hunks** checks recorded document versions, post-apply content hashes and disk state. It restores the approved group through another WorkspaceEdit and refuses to overwrite intervening changes. VS Code native Undo is also available. Recorded Passport events reflect panel actions. Later native Undo or external edits may require a fresh review to reconcile current state.

The command runner permits explicit Node test files and Python pytest files, with supported fixed flags. It resolves the executable, records test/evidence hashes, shows the actual command and requires separate human consent. MCP exposes run_command only when the editor supplies this approval callback. The agent cannot approve its own execution. Shell interpretation is disabled. Commands receive a restricted environment, bounded output and a timeout. Cancellation terminates the process group. Tests execute repository code with local user permissions, so their imports and behavior belong to the user's approved trust boundary.

## Patch Passport

The exported report contains patch/session identifiers, file hashes, hunk decisions, apply/undo observations, approved commands, cwd, test/evidence hashes, exit status, duration, bounded redacted output, security candidates, controlled proof links and uncertainties. It excludes full source/proposed text, prompts and model credentials. Source text remains in the local review panel while it is needed for review and Undo. History is bounded and held in memory until export.

A passed command is evidence of that execution. Security coverage, code correctness and test adequacy are separate questions. Redaction is best effort, and exported evidence should be inspected before public sharing.

## Verification commands

```bash
npm ci
npm run check
npm test
npm run test:editor
```

With local TrueForge 0.183.0 running using the allowlist documented in REVIEW.md:

```bash
npm run test:wire
npm run test:editor:wire
```

The real-runtime wire checks use deterministic inference responses and actual SDK sessions, preloaded tool schemas, MCP reads, TrueForge approval turns and editor proposal handoff. They verify complete bounded source delivery and both full-file and compact patch staging without provider charges. Production-model behavior and the official Flask Tasks A/B/C remain separate release checks.

## Bounded Python request tracing

`SF-FLOW-001` links simple Python request-input assignments to `cursor.execute`, `db.execute`, `os.system`, or a subprocess call with `shell=True`. It records redacted source/propagation/sink lines and the source hash. Reassignment and function boundaries clear tracked values. Traces stop after 50 lines and eight assignments. Findings remain low-confidence candidates.

This lexical pass does not parse Python strings or prove branch feasibility, sanitization, authorization, aliases, or interprocedural reachability. Parameterized SQL values and subprocess argument lists with `shell=False` have negative controls in the test suite. Controlled exploitability proof remains limited to the owned traversal fixture.


## Traversal, cancellation and protocol follow-up

Workspace enumeration is bounded by entries and discovered directories, in addition to accepted-file count. The iterator reads entries incrementally and observes cancellation. Budget exhaustion produces a fixed error with the numeric limit.

Verification waits for the SIGTERM/SIGKILL cancellation sequence to finish even if its leader exits early. The same-group descendant fixture covers cancellation and timeout. Detached processes and arbitrary repository-code effects require OS containment, beyond this process-group lifecycle control.

Tool arguments are validated against the exact advertised bridge schemas before execution. Regression tests cover every required tool input, malformed values, unexpected fields, range limits, Unicode length, enums and invalid JSON-RPC identifiers. Validation error messages omit supplied values.
