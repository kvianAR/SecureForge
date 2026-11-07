import { diffArrays } from 'diff';
import { redactSecrets, hasProposedCredentialContent, sha256 } from './workspace.mjs';

const MAX_BYTES = 256 * 1024;

function linesWithEndings(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

// A review derives hunks from the existing v1 full-content proposal contract.
// Hunk offsets and decisions remain local to the human review layer.
export function createReview(proposal) {
  if (!proposal || proposal.schemaVersion !== 1 || proposal.status !== 'pending' ||
      typeof proposal.id !== 'string' || !proposal.id || proposal.id.length > 200 ||
      typeof proposal.path !== 'string' || !proposal.path ||
      typeof proposal.originalContent !== 'string' || typeof proposal.proposedContent !== 'string' ||
      typeof proposal.rationale !== 'string' || proposal.rationale.length > 2000) {
    throw new Error('Invalid pending v1 proposal');
  }
  for (const content of [proposal.originalContent, proposal.proposedContent]) {
    if (Buffer.byteLength(content) > MAX_BYTES || content.includes('\0')) {
      throw new Error('Review requires bounded UTF-8 text');
    }
  }
  if (redactSecrets(proposal.originalContent) !== proposal.originalContent ||
      hasProposedCredentialContent(proposal.proposedContent)) {
    throw new Error('Review blocked because the content contains detected credentials');
  }
  if (sha256(proposal.originalContent) !== proposal.baseSha256 ||
      sha256(proposal.proposedContent) !== proposal.proposedSha256) {
    throw new Error('Proposal content does not match its SHA-256 hashes');
  }
  const originalLines = linesWithEndings(proposal.originalContent);
  const proposedLines = linesWithEndings(proposal.proposedContent);
  const changes = diffArrays(originalLines, proposedLines, { timeout: 250, maxEditLength: 10000 });
  if (!changes) throw new Error('Diff exceeded the review complexity limit');

  const hunks = [];
  let offset = 0;
  let line = 1;
  let active;
  for (const change of changes) {
    const text = change.value.join('');
    if (!change.added && !change.removed) {
      active = undefined;
      offset += text.length;
      line += change.value.length;
      continue;
    }
    if (!active) {
      active = {
        id: `${proposal.id}:h${hunks.length + 1}`,
        startOffset: offset,
        endOffset: offset,
        startLine: line,
        oldText: '',
        newText: '',
      };
      hunks.push(active);
    }
    if (change.removed) {
      active.oldText += text;
      offset += text.length;
      line += change.value.length;
      active.endOffset = offset;
    } else {
      active.newText += text;
    }
  }
  if (hunks.length === 0) throw new Error('Proposal contains no changes');
  if (hunks.length > 200) throw new Error('Proposal exceeds the 200-hunk review limit');
  return Object.freeze({
    id: proposal.id,
    path: proposal.path,
    baseSha256: proposal.baseSha256,
    originalContent: proposal.originalContent,
    rationale: redactSecrets(proposal.rationale),
    hunks: Object.freeze(hunks.map(hunk => Object.freeze(hunk))),
  });
}

export function composeAcceptedHunks(review, decisions, currentContent) {
  if (sha256(currentContent) !== review.baseSha256) {
    throw new Error('Stale proposal: the document changed. Read it again and prepare a new proposal.');
  }
  const ids = new Set(review.hunks.map(hunk => hunk.id));
  for (const [id, decision] of Object.entries(decisions)) {
    if (!ids.has(id) || !['accept', 'reject'].includes(decision)) {
      throw new Error('Invalid hunk decision');
    }
  }
  if (review.hunks.some(hunk => !Object.hasOwn(decisions, hunk.id))) {
    throw new Error('Accept or reject every hunk before applying');
  }
  let content = '';
  let offset = 0;
  const accepted = [];
  for (const hunk of review.hunks) {
    content += currentContent.slice(offset, hunk.startOffset);
    if (decisions[hunk.id] === 'accept') {
      content += hunk.newText;
      accepted.push(hunk);
    } else {
      content += hunk.oldText;
    }
    offset = hunk.endOffset;
  }
  content += currentContent.slice(offset);
  return { content, accepted };
}
