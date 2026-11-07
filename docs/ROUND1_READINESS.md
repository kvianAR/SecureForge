# Round 1 readiness

## Current qualification

The current PR #16 handoff candidate has 153 passing automated tests, syntax checks, a rebuilt 0.1.4 VSIX and clean-clone setup evidence. Exact-head CI must be checked again before merge. Detailed checkpoint history is in `HANDOFF_PROGRESS_2026-11-06.md`.

| Gate | Observed evidence | Remaining boundary |
| --- | --- | --- |
| Task A | Exact inline prompt, real Muse proposal, installed UI decisions/Apply/Save, 55 passing approved tests, exported hash match, successful Undo | Official screen recording with prescribed terminal verification |
| Task B | Exact unnamed-file prompt, autonomous four-file proposal, six reviewed hunks, 67 approved tests, 102 independent tests and strict Sphinx build, actual masked CLI output and help | Official screen recording with TrueForge session visible |
| Task C | Unreachable provider configured in TrueForge, clear installed-editor failure, unchanged tracked source, returned editor control | Official screen recording; no automatic fallback claim |
| Cancellation | Real Muse run stopped through the sidebar, pending proposals discarded, tracked source unchanged | No measured latency claim |
| Review safety | Synthetic installed UI covers dirty/stale refusal, clean Recheck, Apply/Save and successful guarded Undo | All editor copies closed, Apply blocked, explicit Recheck reopened the unchanged source, separate Apply/Undo passed |
| Defend/Prove | Installed owned lab reproduces baseline failure, reviews repair, passes four regressions and exports independently linked proof | Scope is the controlled fixture, with concurrent replacement excluded |

Evidence is under `outputs/live-model/handoff`. The first Task B candidate failed a nested-masking check and remains recorded. Its replacement passed. The replacement Task B run later refused Undo after source tabs were closed. A separate synthetic normal-flow Undo succeeded. Event evidence describes its recorded moment, not later filesystem state.

## Clean setup

Clone the public repository and use Node.js 22.14 or later.

```bash
git clone https://github.com/S-h-u-b-h-1/SecureForge.git
cd SecureForge
npm ci
npm run check
npm test
npm run package:extension
```

Install `outputs/SecureForge-0.1.4.vsix` through desktop VS Code's Install from VSIX action and reload. Check the loaded version in Review. Generated VSIX binaries are CI/local artifacts and are not committed.

Start the tested local runtime and configure your own model provider in its dashboard.

```bash
HOST=127.0.0.1 OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@0.183.0
```

The repository SDK is pinned to 0.182.0. The observed real-model catalog name is `meta-muse/muse-spark-1-3`, with upstream ID `muse-spark-1.3`. Its registered reasoning option was `minimal` during this handoff. Keep provider keys in TrueForge. Model access and inference charges depend on the provider. See `examples/secureforge-settings.json` for extension settings.

Open the target checkout in VS Code, confirm its workspace name beside the composer, and use SecureForge in the Secondary Side Bar. Changing a terminal directory does not change the active editor workspace.

## Official Flask sequence

Use a disposable Flask 3.1.3 checkout pinned to `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. Create a project-local Python environment with pytest and required Flask extras. Keep the target clean before each qualification. The exact prompts are constants in `scripts/flask-rehearsal.py`; that script itself produces reference changes and is not model-generation evidence.

1. For A, open `src/flask/helpers.py`, select `get_debug_flag`, and submit the exact inline prompt. Review the diff, apply and save. Show `FLASK_DEBUG=off` producing `False` from this checkout's Flask import.
2. For B, use the exact agent-panel prompt with no file hints. Show selected context, named staging approval, at least three changed files, hunk decisions, Apply and Save. Approve the exact CLI test command, show it passing, run the new command against an app and show masked JSON. Briefly show the actual TrueForge session, turns and tool calls.
3. For C, configure a temporary unreachable provider endpoint or invalid key in TrueForge, then repeat A. Show a clear failure, responsive editor and unchanged source. Restore the working model afterward.

All repository tests execute with local-user authority. Apply and Save are separate operations. A command run before proposal application cannot verify the proposed changes.

## Submission assets

The official statement requires a public repository, a maximum four-minute A/B/C screen recording and a one-to-three-page PDF. The PDF must use these headings in order.

1. Team
2. Starting point
3. Architecture on TrueForge
4. How context is selected
5. Model setup
6. Scorecard
7. Tools used
8. Known limitations and what you would do with another month

The official video and public video link are still pending. Its timestamps must be added to the PDF scorecard after recording. Team registration, Team ID and member-detail collection are deferred at Aditya's request. Portal submission and acknowledgement remain pending.

The downloaded official statement was re-read during the handoff. The public portal HTML did not expose a deadline in the retrieved page, so the previously reported date is not independently reconfirmed here.
