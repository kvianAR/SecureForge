import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { sha256 } from './workspace.mjs';

export async function createOwnedLab() {
  // Keep fixture creation outside repository-controlled directory parents.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'secureforge-security-lab-'));
  try {
    await mkdir(path.join(directory, 'vulnerable'));
    await mkdir(path.join(directory, 'safe'));
    for (const relative of ['vulnerable/storage.mjs', 'safe/storage.mjs', 'regression.test.mjs']) {
      await copyFile(new URL(`../fixtures/security-lab/${relative}`, import.meta.url),
        path.join(directory, relative), constants.COPYFILE_EXCL);
    }
    return { root: directory, testPath: 'regression.test.mjs', targetPath: 'vulnerable/storage.mjs' };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function assessFixProof({ before, after, beforeSha256, afterContent, finding, approvedProposalId }) {
  const beforeTest = before.command?.sources?.find(source => source.path === 'regression.test.mjs');
  const afterTest = after.command?.sources?.find(source => source.path === 'regression.test.mjs');
  const beforeTarget = before.command?.targets?.find(source => source.path === finding.path);
  const afterTarget = after.command?.targets?.find(source => source.path === finding.path);
  const expectedFailure = /not ok[^\n]*parent-directory/.test(before.output ?? '') &&
    /ok[^\n]*permitted notes remain readable/.test(before.output ?? '');
  const verified = before.executed === true && after.executed === true && before.status === 'failed' &&
    after.status === 'passed' && before.exitCode !== 0 && after.exitCode === 0 &&
    before.command.cwd === after.command.cwd && beforeTest?.sha256 === afterTest?.sha256 &&
    Boolean(beforeTest) && beforeSha256 === finding.sourceSha256 && Boolean(approvedProposalId) &&
    beforeTarget?.sha256 === beforeSha256 && afterTarget?.sha256 === sha256(afterContent) &&
    beforeTarget?.sha256 !== afterTarget?.sha256 && expectedFailure && /pass\s+4/.test(after.output ?? '');
  return {
    findingId: finding.id, proposalId: approvedProposalId, status: verified ? 'verified_on_owned_fixture' : 'inconclusive',
    beforeReceiptId: before.id, afterReceiptId: after.id,
    beforeSha256, afterSha256: sha256(afterContent),
    limitation: 'Evidence covers the owned regression cases under these local conditions. Concurrent path replacement is outside this fixture.',
  };
}
