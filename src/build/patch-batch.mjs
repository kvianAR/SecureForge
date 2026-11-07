import { redactSecrets, hasProposedCredentialContent } from '../workspace.mjs';
import { MAX_BATCH_FILES, MAX_BATCH_CONTENT_BYTES } from './batches.mjs';

// Compact transport only: the existing batch store still creates full v1
// proposals and performs its normal hash checks and all-or-nothing staging.
export async function proposePatchBatch({ workspace, batches, edits, rationale = '', signal }) {
  signal?.throwIfAborted();
  if (!Array.isArray(edits) || edits.length < 2 || edits.length > MAX_BATCH_FILES) {
    throw new Error('Patch batch requires 2..8 existing files');
  }
  if (Buffer.byteLength(JSON.stringify({ edits, rationale }), 'utf8') > 64 * 1024) {
    throw new Error('Patch input exceeds 64 KiB');
  }
  const seen = new Set();
  const expanded = [];
  let totalBytes = 0;
  for (const edit of edits) {
    signal?.throwIfAborted();
    if (!edit || typeof edit.path !== 'string' || !/^[0-9a-f]{64}$/.test(edit.expectedSha256 ?? '') ||
        !Array.isArray(edit.replacements) || edit.replacements.length < 1 || edit.replacements.length > 12) {
      throw new Error('Invalid patch edit');
    }
    const key = edit.path.replaceAll('\\', '/').normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate patch file');
    seen.add(key);
    const source = await workspace.rawForProposal(edit.path);
    signal?.throwIfAborted();
    if (source.relative !== edit.path || source.hash !== edit.expectedSha256) throw new Error('Stale or noncanonical patch source');
    if (redactSecrets(source.relative) !== source.relative || redactSecrets(source.raw) !== source.raw) {
      throw new Error('Credential-bearing patch source excluded');
    }
    const changes = edit.replacements.map(replacement => {
      if (!replacement || typeof replacement.oldText !== 'string' || !replacement.oldText ||
          typeof replacement.newText !== 'string' || replacement.oldText === replacement.newText) {
        throw new Error('Replacement requires nonempty exact oldText and changed newText');
      }
      const start = source.raw.indexOf(replacement.oldText);
      if (start < 0 || source.raw.indexOf(replacement.oldText, start + 1) >= 0) {
        throw new Error('Replacement oldText must match exactly once in original source');
      }
      return { start, end: start + replacement.oldText.length, text: replacement.newText };
    }).sort((a, b) => a.start - b.start);
    for (let index = 1; index < changes.length; index++) {
      if (changes[index].start < changes[index - 1].end) throw new Error('Overlapping replacements are not allowed');
    }
    let proposedContent = source.raw;
    for (const change of changes.toReversed()) {
      proposedContent = proposedContent.slice(0, change.start) + change.text + proposedContent.slice(change.end);
    }
    if (hasProposedCredentialContent(proposedContent)) throw new Error('Credential-bearing proposed content excluded');
    totalBytes += Buffer.byteLength(proposedContent, 'utf8');
    if (totalBytes > MAX_BATCH_CONTENT_BYTES) throw new Error('Patch batch content exceeds 256 KiB');
    expanded.push({ path: source.relative, expectedSha256: source.hash, proposedContent });
  }
  signal?.throwIfAborted();
  const batch = await batches.proposeBatch({ edits: expanded, rationale });
  if (signal?.aborted) {
    batches.discardBatch(batch.id);
    signal.throwIfAborted();
  }
  return batch;
}
