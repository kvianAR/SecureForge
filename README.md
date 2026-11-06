# SecureForge

> **Status: local beta — merged VS Code sidebar agent with explicit per-hunk approval.**

SecureForge is a security-first VS Code coding assistant powered by local **TrueForge**. The extension supports live proposal delivery, per-hunk review for existing-file batches, guarded apply/Undo, separately approved verification commands, cancellation, read-only security candidates, a controlled repair lab and exported Patch Passports. Build, Defend and Prove share the existing v1 proposal and batch contracts.

Local verification includes real VS Code editor tests and actual TrueForge runtime/SDK/MCP sessions using a deterministic local inference fixture. Configure your own model in TrueForge for production-model verification. Official competition Tasks A/B/C remain release acceptance work.

## Contributors and responsibility

- **Aditya Ranjan** handles Defend/Prove, approval UI, path and tool security audit, verification, cancellation integrity and security review. [@kvianAR](https://github.com/kvianAR)
- **Shubhaang Kataruka** handles Build, TrueForge sessions, coding agent, source retrieval, edit proposals and core integration. [@S-h-u-b-h-1](https://github.com/S-h-u-b-h-1)
- **Joint:** shared contracts, integration, mandatory competition tasks and release checks.

## Start here — VS Code sidebar

SecureForge's VSIX is a **local beta**, not a generally certified production coding agent. A real pinned Flask task successfully completed model-generated staging → human-reviewed editor apply → explicit Save → 126 passing targeted tests (3 skipped). That is concrete integration evidence, not a guarantee that arbitrary tasks, models or source repositories work. Use a trusted local repository.

1. Start local TrueForge (`npx @truefoundry/trueforge@0.183.0`) and configure an available model at `http://localhost:8790`. The official SDK in this repository remains pinned to `0.182.0`. Keep TrueForge and workspace tools bound to localhost.
2. Build the extension in the **SecureForge source repository**:

   ```bash
   npm ci
   npm run check
   npm test
   npm run package:extension
   ```

3. In VS Code open **Extensions → … → Install from VSIX…** and choose `outputs/SecureForge-0.1.1.vsix`, then reload the window.
   The **SecureForge Review** panel displays the loaded extension version. If it doesn't show **0.1.1** after installation, fully quit VS Code and reinstall the VSIX; an earlier extension host can still be active.
4. Open the **target repository folder you actually want to change** (e.g., Flask for a Flask request). The name beside the chat send button identifies the active target; opening a different terminal folder does not switch the VS Code workspace.
5. In the Secondary Side Bar, select **SecureForge**. Type an instruction in the bottom composer; press **Enter** to send or **Shift+Enter** for a line break. The paperclip attaches file context, the stack icon adds symbol context, and Stop cancels an active run. If just one local model is discoverable, the extension selects it; otherwise pick or enter the configured model.
6. If the task obviously belongs to a different project (such as changing Flask environment variables inside a Node-only workspace), SecureForge stops **before contacting the model**. Click **Recent projects** to open VS Code's existing project history, or **Browse folders** to choose a folder yourself.
7. When SecureForge stages a proposal, a **Review proposed changes** panel opens in the editor. Accept or reject every hunk, then explicitly apply accepted hunks. The code changes begin in the editor buffer and require your own Save and regression tests. The model never commits on your behalf.
8. After applying accepted hunks, **save the files yourself** and choose **Run tests (save files first)** in the chat. Select Node or Python, choose up to 20 eligible test files, and approve the exact command in the confirmation dialog. A passing test receipt is reported in the sidebar; full details remain in **Output → SecureForge Activity**. Nothing runs automatically.

**Never merge or approve generated patches solely because the chat says they are complete.** Review the diff, run relevant tests, and check `git diff --check`.

### Development and verification

```bash
npm ci
npm run check
npm test
npm run package:extension
# Requires desktop VS Code and uses an isolated editor-host profile:
npm run test:editor
# Requires a local TrueForge runtime; uses deterministic inference, not a production model:
npm run test:editor:wire
```

Real-model requests are **not run by CI** because they require a locally configured provider. The deterministic TrueForge wire fixture confirms transport, temporary authenticated MCP, source hashes, and proposal staging, not the semantic correctness of an arbitrary model response. Read the [release gates and merge order](docs/RELEASE_GATES.md) before merging the stacked PRs.

The model has only bounded read/search/propose workspace tools. File writes are not an agent capability. A separately approved test runner can execute allowlisted tests with the user account's permissions. Secrets are filtered on a best-effort basis, not guaranteed DLP.

## Tool guarantees (current implementation)

- `read_file` — bounded line-numbered source content with SHA-256; deny secret-like names, binaries, oversized files and symlinks.
- `search_workspace` — bounded literal repository search with line evidence; no code execution.
- `lookup_symbol` — lexical candidate lookup; **not** a full AST/symbol resolver.
- `propose_edit` — stores full proposed content in process memory, requiring the expected SHA-256; **never writes source files**.
- `get_proposal` and `check_proposal` — recover a proposal for UI display and detect stale bases.

Known limitations: Linux workspace reads require `/proc/self/fd` and macOS reads use `O_NOFOLLOW_ANY` (test macOS support before relying on it); proposal persistence and broad production-model editor verification beyond the pinned Flask task remain pending; no full symbol analysis; verification uses the editor-approved runner; automatic model fallback remains pending; no full MCP interoperability suite yet; best-effort secret redaction is not a DLP guarantee. Reading is blocked for symlinks, including internal symlinks, to fail closed. The bridge is for local development only.

See [Architecture and integration contract](docs/ARCHITECTURE.md) for the handoff with Aditya. Please don't merge to `main` without review and clean-clone tests.

## Local hunk review extension

The security branch includes a VS Code review milestone for pending v1 proposals. It supports independent hunk decisions, guarded editor-buffer application and native Undo. Run `npm ci`, open this repository in VS Code, press F5 and choose **Run SecureForge Review**. Then run **SecureForge: Open Two-Hunk Review Demo** in the development host. See [review setup and limitations](docs/REVIEW.md). Live delivery uses a temporary authenticated MCP connector, SDK session streaming and explicit staging approval. It has been verified against runtime 0.183.0 using a deterministic local inference fixture. Production-model verification requires a configured provider.

## Security workflow and evidence

Use **SecureForge: Security Review** for bounded read-only candidate findings. **Start Owned Security Lab** demonstrates an explicit reviewed repair with failing-before/passing-after regressions. **Export Patch Passport** records patch decisions, command receipts, finding confidence and remaining uncertainties. See [security workflow and supported scope](docs/SECURITY_WORKFLOW.md).

## Round 1 deliverables

Installable VSIX, bounded task context, inline-selection guard and right-side chat are included in the draft stack. Follow [Round 1 readiness and recording plan](docs/ROUND1_READINESS.md) for setup, model configuration, official-task rehearsal evidence and remaining submission gates. The write-up PDF is a readiness draft. Live-model A/B, the official video and portal submission remain pending.
