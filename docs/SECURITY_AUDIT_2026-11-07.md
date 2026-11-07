# SecureForge source audit — 7 November 2026

## Scope and evidence

Standard source-only audit of maintained runtime, extension, packaging, CI, fixtures and security-relevant tests. The initial source was 4f15e27f743ff6fdca8d200486a6c5dd98a18ed6. Corrective commits ff1ccc0 and 1a08ad1 were independently reviewed. Current security code is 1a08ad157046230f509a5fb3772e3fdbcf6b147f. The worktree also contained a modified release-verification artifact and untracked Playwright scratch, both outside audit source scope.

Four reconnaissance reviews, eight focused hunters, a post-wave critic, a distinct final-clean critic and two fresh candidate validators completed. No agent budget was set. All 19 planned coverage units have owned source checks. Final critics accepted no material missing units or reassignment. Two units retain candidate history with final rejected dispositions after fixes. There are zero unresolved candidate records, zero deferred units and zero blocked units.

Audit agents executed no target code and contacted no network or live control plane. The complete OS-enforced sandbox needed for adversarial reproduction was not established. Separately authorized product regression, packaged editor, owned-lab and TrueForge integration checks are reported separately below. This audit does not establish arbitrary model efficacy, deployment isolation or exhaustive exploit coverage.

## Current findings

No confirmed or unresolved needs-validation finding remains in current source. The two new baseline candidates were independently rejected as current findings after their prerequisites were removed. They retain stable fingerprints in findings.json. Native exploitation of the old candidates was never established.

| Corrective work | Current control | Evidence |
| --- | --- | --- |
| Command selector and source-hash disagreement | Backslash-bearing verification arguments fail before source reads, approval or execution | src/commands.mjs and command regression |
| Shared workspace temporary-parent race | Owned lab uses a fresh OS-temporary directory, exclusive fixture copies and partial-creation cleanup | src/proof.mjs, production caller and private-directory regression |
| Stale downloadable CI installer | Upload uses the same version-derived archive validated by the preceding job step | .github/workflows/ci.yml and downloaded 0.1.4 artifact |
| Initial workspace markup rendering | Sidebar text and attribute values are HTML-escaped | extension/agent-panel.mjs and metacharacter regression |
| Failed listener startup cleanup | Workspace closes before a listen error escapes | src/mcp-server.mjs and occupied-port regression |

## Prior-run revalidation

The compatible run-1 was a partial quick source-only review at 8d814af. Its four needs-validation leads covered post-cancel MCP disclosure, unbounded proposal import, credential-bearing filename output and raw-search credential membership. Current source checks refuted those old paths. Cancellation is checked before and after dispatch and before response. Proposal import uses a bounded regular-file descriptor. Shared paths screen recognized credentials, and search matches disclosure-safe text.

The three previously deferred obligations now have source coverage. Traversal has entry and directory budgets with cancellation. Every advertised tool schema validates before dispatch. Process-group escalation remains owned until cleanup finishes even if the leader closes first. There were no carried same-source confirmed exclusions.

## Positive controls

Per-run MCP uses loopback binding, a fresh capability and explicit tool selection. Workspace reads enforce restricted canonical paths, regular files, descriptor-based no-follow reads, UTF-8 and actual-byte bounds. Complete bundles are all-or-nothing with exact content hashes. Proposals remain in memory. Editor application requires explicit hunk decisions, source hashes, clean versions and grouped validation. Recheck can recover unchanged closed files. Commands require a separate exact-command approval and preserve saved-source checks. Proof records link owned before/after receipts, tests, targets and approvals.

## Remaining hardening and limits

Directory enumeration uses pathname-based opendir, while content reads have stronger descriptor confinement. The source trace did not establish attacker-readable outside filename output. macOS root-directory replacement has a different inode lifecycle from Linux. These remain documented hardening considerations rather than confirmed findings.

HTTP per-request work and Node reception defaults are bounded. Aggregate loopback request caps and request-disconnect cancellation could strengthen resource handling. No meaningful cross-principal availability effect was demonstrated. Generic immutable action pinning and locked packaging-tool resolution are future supply-chain improvements without an observed compromised input or privileged publication path.

Credential detection remains best effort. Approved tests run repository code with local-user permissions. Multi-file reads are not atomic snapshots. Exported evidence records historical events and later edits can change disk state. Provider ownership, remote retention and OS-wide isolation were outside this source review.

## Separate product qualification

The corrected source passed 153 automated tests and syntax checks. Packaged VS Code checks cover activation, mixed hunk decisions, Apply/Undo, multi-file/stale/cancellation boundaries and the owned repair proof. Deterministic TrueForge transport checks cover full-file and compact-batch modes. Exact-head Ubuntu Node 22 and macOS Node 26 CI passed. The retained CI archive is version 0.1.4, and its bundled code matched the installed local build at the artifact checkpoint.

Earlier real Muse installed UI qualification recorded Task A with 55 approved tests, Task B with four files, 67 approved tests, 102 independent tests and a strict Sphinx build, Task C with an unreachable provider, and real-run Stop cancellation. Failed earlier candidates and the closed-document Undo refusal remain documented separately. These are observed runs, rather than guarantees for every response.

PDF finalization, team details, the official video and portal submission remain user-owned. They are outside this technical completion scope.
