import { randomUUID } from 'node:crypto';
import { sha256, redactSecrets, hasProposedCredentialContent } from './workspace.mjs';

const MAX_PROPOSAL_BYTES = 256 * 1024;

export class ProposalStore {
  #proposals = new Map();
  constructor(workspace, { limit = 100 } = {}) {
    this.workspace = workspace;
    this.limit = limit;
  }

  async proposeEdit({ path, expectedSha256, proposedContent, rationale = '' }) {
    if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
      throw new Error('expectedSha256 from read_file is required');
    }
    if (typeof proposedContent !== 'string' || Buffer.byteLength(proposedContent) > MAX_PROPOSAL_BYTES) {
      throw new Error('proposedContent must be a UTF-8 string <= 256 KiB');
    }
    if (typeof rationale !== 'string' || rationale.length > 2000) throw new Error('Invalid rationale');
    const original = await this.workspace.rawForProposal(path);
    if (original.hash !== expectedSha256) throw new Error('Stale base: read file again before proposing');
    if (redactSecrets(original.raw) !== original.raw) {
      throw new Error('Source contains redacted credentials: proposal blocked to prevent destructive replacements');
    }
    if (original.raw === proposedContent) throw new Error('Proposal contains no changes');
    // Keep full-file staging consistent with compact patch staging. Only
    // literal harmless test sentinels are exempt, never real credentials.
    if (hasProposedCredentialContent(proposedContent)) {
      throw new Error('Credential-bearing proposed content excluded');
    }
    if (this.#proposals.size >= this.limit) throw new Error('Too many pending proposals');
    const proposal = Object.freeze({
      schemaVersion: 1,
      id: randomUUID(),
      path: original.relative,
      baseSha256: original.hash,
      proposedSha256: sha256(proposedContent),
      originalContent: original.raw,
      proposedContent,
      rationale,
      createdAt: new Date().toISOString(),
      status: 'pending',
    });
    this.#proposals.set(proposal.id, proposal);
    return this.#summary(proposal);
  }

  #summary(p) {
    return { schemaVersion: p.schemaVersion, id: p.id, path: p.path,
      baseSha256: p.baseSha256, proposedSha256: p.proposedSha256,
      rationale: p.rationale, createdAt: p.createdAt, status: p.status,
      originalBytes: Buffer.byteLength(p.originalContent),
      proposedBytes: Buffer.byteLength(p.proposedContent) };
  }

  getProposal(id) {
    const proposal = this.#proposals.get(id);
    if (!proposal) throw new Error('Proposal not found');
    return { ...proposal }; // Returned for UI integration; never written to disk here.
  }

  async checkProposal(id) {
    const proposal = this.getProposal(id);
    try {
      const current = await this.workspace.rawForProposal(proposal.path);
      return { id, path: proposal.path, fresh: current.hash === proposal.baseSha256,
        expectedSha256: proposal.baseSha256, currentSha256: current.hash };
    } catch (err) {
      return { id, path: proposal.path, fresh: false, reason: err.message };
    }
  }

  discard(id) {
    return this.#proposals.delete(id);
  }
}
