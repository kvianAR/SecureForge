"""Create the evidence-backed two-page Round 1 draft with deferred fields visible."""
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Table, TableStyle

output = Path('outputs/SecureForge-Round1-Writeup-DRAFT.pdf')
output.parent.mkdir(exist_ok=True)
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='BodySF', fontName='Helvetica', fontSize=9.5, leading=13, spaceAfter=7))
styles.add(ParagraphStyle(name='SectionSF', fontName='Helvetica-Bold', fontSize=12, leading=15, spaceBefore=9, spaceAfter=6))
styles.add(ParagraphStyle(name='SmallSF', fontName='Helvetica', fontSize=8, leading=10))
styles.add(ParagraphStyle(name='BannerSF', fontName='Helvetica-Bold', fontSize=10, leading=14,
                          textColor=colors.HexColor('#9a3412'), spaceAfter=10))
story = []


def paragraph(text, style='BodySF'):
    story.append(Paragraph(text, styles[style]))


def section(title):
    paragraph(title, 'SectionSF')


def footer(canvas, document):
    canvas.setStrokeColor(colors.HexColor('#cbd5e1'))
    canvas.line(18 * mm, 16 * mm, 192 * mm, 16 * mm)
    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(colors.HexColor('#475569'))
    canvas.drawString(18 * mm, 11 * mm, 'SecureForge | Evidence-backed draft | 6 November 2026')
    canvas.drawRightString(192 * mm, 11 * mm, str(document.page))


paragraph('SecureForge', 'Title')
paragraph('ROUND 1 DRAFT - team fields and official video timestamps pending', 'BannerSF')
section('1. Team')
paragraph('Aditya Ranjan (@kvianAR) and Shubhaang Kataruka (@S-h-u-b-h-1). '
          'College/employer and team registration details are deferred at Aditya\'s request. '
          'Shubhaang developed Build and TrueForge integration. Aditya owns the remaining '
          'Build qualification, Defend, Prove and submission work.')
section('2. Starting point')
paragraph('SecureForge is a custom VS Code extension and workspace-tool implementation built from scratch. '
          'It uses the official TrueForge runtime and SDK. The handoff started from PR #16 candidate '
          '925d62c663a07f0eb9f0975b88eb9fbd5dd367b0 and added independently verified repairs. '
          'The executable agent definition is src/agent.mjs. '
          '<link href="https://github.com/S-h-u-b-h-1/SecureForge">Public repository on GitHub</link>. '
          'Competition tests use Flask 3.1.3 at 22d924701a6ae2e4cd01e9a15bbaf3946094af65. '
          'Flask\'s BSD license is retained with the reference artifacts.')
section('3. Architecture on TrueForge')
paragraph('The extension creates SDK sessions, sends turns and renders streamed events. TrueForge routes '
          'the configured provider and dispatches a temporary authenticated loopback MCP connector. '
          'The agent chooses bounded discovery, read/search, source-bundle and proposal tools. '
          'A command tool is available only with separate local command confirmation. Provider credentials '
          'stay in TrueForge. The extension has no direct model-provider client.')
paragraph('Named tool approvals permit in-memory staging. Human hunk decisions, guarded editor Apply, '
          'explicit Save and test approval remain separate. Coordinated application uses one WorkspaceEdit '
          'after validating file hashes and editor versions. Repeated approval refs are refused and distinct '
          'requests are capped at eight. Cancellation discards pending proposals. Patch Passport records '
          'decisions, applied hashes, test receipts and controlled security-proof links.')
section('4. How context is selected')
paragraph('Automatic lexical ranking combines filenames, matching source lines, explicit attachments '
          'and test/documentation bonuses. At most 12 excerpts fit a default 24,000 UTF-8-byte budget. '
          'Scans have independent byte/file/directory-entry limits. Evidence shows paths, reasons, line '
          'ranges and SHA-256 hashes. Model-driven discovery adds literal import relationships. '
          'Complete source bundles contain 1-4 existing files under 96 KiB total and fail as a whole '
          'on denied input. This combines bounded retrieval with exact text for reliable compact edits. '
          'Snapshots across files are not atomic. Advanced harness compaction or subagents are not claimed.')
story.append(PageBreak())
section('5. Model setup')
paragraph('Observed tests used local TrueForge 0.183.0, SDK 0.182.0 and configured model '
          'meta-muse/muse-spark-1-3, upstream muse-spark-1.3 through the Meta OpenAI-compatible API. '
          'The local catalog advertised minimal reasoning during this handoff. Inference ran remotely '
          'through that provider. Costs were not measured, so no cost estimate is asserted. '
          'Users configure providers in TrueForge Settings and select the model FQN in SecureForge settings. '
          'Task C used a temporary unreachable provider, then restored Muse.')
section('6. Scorecard')
paragraph('Official video timestamps remain pending. The rows below describe observed evidence, '
          'rather than awarded scores. Automated UI interactions are distinct from a human-operated recording.', 'SmallSF')
rows = [['Criterion', 'Video time', 'Observed claim / remaining evidence']]
claims = [
    ('A1 Inline edit', 'Real Task A review, two hunks, Apply/Save and 55 approved tests.'),
    ('A2 Agent mode', 'Exact Task B prompt discovered and changed three files without file hints.'),
    ('A3 Streaming/cancellation', 'Real streamed run stopped through sidebar; tracked source unchanged.'),
    ('B1 Context assembly', 'Ranked bounded retrieval, complete bundle and source hashes observed in B.'),
    ('B2 Diff safety', 'Mixed decisions, normal Undo and closed-source Recheck tested in installed UI.'),
    ('B3 Resilience', 'Unreachable TrueForge provider gave a clear failure and unchanged source.'),
    ('B4 TrueForge depth', 'Sessions, streamed turns, authenticated MCP and named staging approvals.'),
    ('C1 Video', 'Official ordered A/B/C recording and public link remain pending.'),
    ('C2 Write-up', 'Architecture, trade-offs and limitations provided; timestamps/team fields pending.'),
]
for criterion, claim in claims:
    rows.append([Paragraph(criterion, styles['SmallSF']), Paragraph('Pending', styles['SmallSF']),
                 Paragraph(claim, styles['SmallSF'])])
table = Table(rows, colWidths=[41 * mm, 21 * mm, 112 * mm], repeatRows=1)
table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#e2e8f0')),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, 0), 8),
    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ('TOPPADDING', (0, 0), (-1, -1), 5),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ('GRID', (0, 0), (-1, -1), 0.3, colors.HexColor('#cbd5e1')),
]))
story.append(table)
section('7. Tools used')
paragraph('Codex assisted implementation, review, tests and documentation. Node.js tests, esbuild, '
          'VS Code editor-host checks, the official TrueForge SDK, Muse, project-local Python/pytest, '
          'Playwright CDP and ReportLab supported qualification. Deterministic inference fixtures '
          'are labelled separately from real-model runs. Evidence is in outputs/live-model/handoff.', 'SmallSF')
section('8. Known limitations and what you would do with another month')
paragraph('150 automated regressions and real runs cover observed conditions. Task B initially failed '
          'nested masking; the replacement passed 66 approved and 101 independent checks. Its later '
          'Undo refusal after closing source tabs remains documented. Separate synthetic closed-source '
          'Recheck and normal Undo passed. Security proof covers four owned-fixture cases and excludes '
          'concurrent path replacement. Tests execute with local-user authority. Secret filtering is best '
          'effort. MCP supports a bounded subset. Automatic fallback, AST-aware retrieval, new-file edits '
          'and persistent proposals remain future work. Another month would prioritize measured cross-model '
          'evaluations, context-engineering experiments and broader compatibility tests. Official video, '
          'team fields, final scorecard timestamps and portal acknowledgement remain pending.', 'SmallSF')
SimpleDocTemplate(str(output), pagesize=(210 * mm, 297 * mm), rightMargin=18 * mm, leftMargin=18 * mm,
                  topMargin=16 * mm, bottomMargin=22 * mm, title='SecureForge Round 1 Draft',
                  author='SecureForge').build(story, onFirstPage=footer, onLaterPages=footer)
print(output)
