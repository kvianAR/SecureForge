#!/usr/bin/env node
import http from 'node:http';
import { Workspace } from './workspace.mjs';
import { ProposalStore } from './proposals.mjs';
import { BatchProposalStore } from './build/batches.mjs';
import { proposePatchBatch } from './build/patch-batch.mjs';
import { discoverRelevantFiles } from './build/repository-discovery.mjs';
import { readSourceBundle } from './build/source-bundle.mjs';
import { validateToolArguments } from './tool-schema.mjs';

const TOOLS = [
  { name: 'read_source_bundle', description: 'Read 1..4 complete existing source files, at most 96 KiB combined. Read-only, all-or-nothing credential screening, exact source hashes. Choose paths after discovery.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 1024 } } }, required: ['paths'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'discover_repository', description: 'Rank bounded source/test candidates and lexical import relationships. Untrusted relevance hints require focused reads.',
    inputSchema: { type: 'object', properties: { task: { type: 'string', minLength: 3, maxLength: 400 } }, required: ['task'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'read_file', description: 'Read bounded numbered lines from a permitted workspace file. Returns SHA-256 for version-aware proposals.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, maxLines: { type: 'integer', minimum: 1, maximum: 180 } }, required: ['path'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'search_workspace', description: 'Find literal text matches across permitted repository files. Never executes repository code.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 2, maxLength: 120 }, maxResults: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'lookup_symbol', description: 'Lexical candidate lookup for a symbol; results are not verified AST definitions.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string', minLength: 2, maxLength: 100, pattern: '^[A-Za-z_$][\\w$]{1,99}$' } }, required: ['symbol'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'propose_edit', description: 'Create an UNAPPLIED in-memory full-file edit proposal. Does not write any source file. Requires a SHA-256 from read_file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, expectedSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, proposedContent: { type: 'string' }, rationale: { type: 'string', maxLength: 2000 } }, required: ['path', 'expectedSha256', 'proposedContent'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'get_proposal', description: 'Retrieve a pending in-memory edit proposal for user review (not approval).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'check_proposal', description: 'Check whether an in-memory edit proposal is stale against current disk content.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'propose_batch', description: 'Stage 2..8 coordinated UNAPPLIED file edit proposals atomically. Requires each original SHA-256. No source file writes.',
    inputSchema: { type: 'object', properties: {
      edits: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'object', properties: {
        path: { type: 'string' }, expectedSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, proposedContent: { type: 'string' }, rationale: { type: 'string', maxLength: 2000 },
      }, required: ['path', 'expectedSha256', 'proposedContent'], additionalProperties: false } },
      rationale: { type: 'string', maxLength: 2000 },
    }, required: ['edits'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'propose_patch_batch', description: 'Stage 2..8 coordinated UNAPPLIED proposals using compact exact-text replacements. Read complete sources first. Each oldText must match exactly once in the original file. Preserves all other bytes, including line endings. No disk writes; review and execution approvals remain separate.',
    inputSchema: { type: 'object', properties: {
      edits: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'object', properties: {
        path: { type: 'string' }, expectedSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        replacements: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', properties: {
          oldText: { type: 'string', minLength: 1, maxLength: 65536 }, newText: { type: 'string', maxLength: 65536 },
        }, required: ['oldText', 'newText'], additionalProperties: false } },
      }, required: ['path', 'expectedSha256', 'replacements'], additionalProperties: false } },
      rationale: { type: 'string', maxLength: 2000 },
    }, required: ['edits'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'get_batch', description: 'Return a pending batch with the existing v1 proposal IDs; no file contents or approval decisions.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'check_batch', description: 'Recheck every underlying file SHA-256; never authorizes applying a patch.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
];

export async function createMcpServer({ root, port = 8792, host = '127.0.0.1', accessToken, onProposal = () => {}, onRunCommand, signal, onTool = () => {} }) {
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('MCP bridge must bind to loopback');
  const workspace = await new Workspace(root).init();
  const proposals = new ProposalStore(workspace);
  const batches = new BatchProposalStore(proposals);
  const tools = [...TOOLS];
  if (onRunCommand) tools.push({
    name: 'run_command', description: 'Request a bounded, separately approved test run. Python example: {"executable":"python3","args":["-m","pytest","tests/test_helpers.py","tests/test_cli.py","-q"]}. Node example: {"executable":"node","args":["--test","test/agent.test.mjs"]}. Only workspace-relative explicit test files (max 20) are accepted; no shells, absolute paths, arbitrary flags or direct .venv executables. SecureForge selects the virtual environment and local Python src path. Tests execute repository code with the local user permissions; a rejected command has NOT run tests.',
    inputSchema: { type: 'object', properties: {
      executable: { type: 'string', enum: ['node', 'python3'] },
      args: { type: 'array', items: { type: 'string', maxLength: 500 }, minItems: 2, maxItems: 25 },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
    }, required: ['executable', 'args'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  });
  const commands = {
    read_source_bundle: p => readSourceBundle({ workspace, paths: p.paths, signal }),
    discover_repository: p => discoverRelevantFiles({ workspace, task: p.task, signal }),
    read_file: (p) => workspace.readFile(p.path, { startLine: p.startLine, maxLines: p.maxLines }),
    search_workspace: (p) => workspace.searchWorkspace(p.query, { maxResults: p.maxResults, signal }),
    lookup_symbol: (p) => workspace.lookupSymbol(p.symbol, { signal }),
    propose_edit: async (p) => {
      const result = await proposals.proposeEdit(p);
      onProposal({ kind: 'proposal', id: result.id });
      return result;
    },
    get_proposal: (p) => proposals.getProposal(p.id),
    check_proposal: (p) => proposals.checkProposal(p.id),
    propose_batch: async (p) => {
      const result = await batches.proposeBatch(p);
      onProposal({ kind: 'batch', id: result.id });
      return result;
    },
    propose_patch_batch: async (p) => {
      const result = await proposePatchBatch({ workspace, batches, ...p, signal });
      onProposal({ kind: 'batch', id: result.id });
      return result;
    },
    get_batch: (p) => batches.getBatch(p.id),
    check_batch: (p) => batches.checkBatch(p.id),
  };
  if (onRunCommand) commands.run_command = parameters => onRunCommand(workspace, parameters);
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (accessToken && req.headers.authorization !== `Bearer ${accessToken}`) {
      return send(401, { error: 'Bridge authorization required' });
    }
    // Origin validation helps prevent browser-based DNS rebinding; host is loopback only.
    const origin = req.headers.origin;
    if (origin) {
      try {
        const u = new URL(origin);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return send(403, { error: 'Origin not allowed' });
      } catch { return send(403, { error: 'Origin not allowed' }); }
    }
    if (signal?.aborted) return send(410, { error: 'MCP session cancelled' });
    if (req.url === '/health' && req.method === 'GET') return send(200, { status: 'ok', root: '(private)' });
    if (req.url !== '/mcp' || req.method !== 'POST') return send(405, { error: 'Use POST /mcp' });
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) return send(415, { error: 'JSON required' });
    const chunks = [];
    let byteCount = 0;
    try {
      for await (const chunk of req) {
        byteCount += chunk.length;
        if (byteCount > 320 * 1024) return send(413, { error: 'MCP request too large' });
        chunks.push(chunk);
      }
      // Buffer chunks are arbitrary transport boundaries, not UTF-8 character
      // boundaries. Decode once after the bounded body has been assembled.
      const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, byteCount));
      const message = JSON.parse(body);
      if (message === null || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || !message.method || typeof message.method !== 'string' ||
          (Object.hasOwn(message, 'id') && message.id !== null && typeof message.id !== 'string' && !(typeof message.id === 'number' && Number.isFinite(message.id)))) {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      }
      if (!Object.hasOwn(message, 'id')) { res.writeHead(202); return res.end(); }
      const result = async () => {
        switch (message.method) {
          case 'initialize': return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'secureforge-workspace', version: '0.1.0' } };
          case 'ping': return {};
          case 'tools/list': return { tools };
          case 'tools/call': {
            const name = message.params?.name;
            if (!Object.hasOwn(commands, name)) throw new Error('Unknown tool');
            const params = message.params?.arguments === undefined ? {} : message.params.arguments;
            try {
              validateToolArguments(tools.find(tool => tool.name === name).inputSchema, params);
              signal?.throwIfAborted();
              onTool({ name, status: 'started' });
              const data = await commands[name](params);
              signal?.throwIfAborted();
              const sources = name === 'read_source_bundle' ? data.files : name === 'read_file' ? [data] : [];
              onTool({ name, status: 'completed', sources: sources.map(source => ({ path: source.path, sha256: source.sha256 })) });
              return { content: [{ type: 'text', text: JSON.stringify(data) }] };
            } catch (err) {
              // Do not include the tool payload or exception text in activity
              // telemetry. Operators need to distinguish a failed tool call
              // from a model turn that simply chose not to stage a proposal.
              onTool({ name, status: 'failed' });
              return { isError: true, content: [{ type: 'text', text: err.message }] };
            }
          }
          default: return undefined;
        }
      };
      const value = await result();
      if (signal?.aborted) return send(410, { error: 'MCP session cancelled' });
      if (value === undefined) return send(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      return send(200, { jsonrpc: '2.0', id: message.id, result: value });
    } catch (err) {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC payload' } });
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  } catch (error) {
    await workspace.close();
    throw error;
  }
  return { server, workspace, proposals, batches, address: server.address() };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  createMcpServer({
    root: process.env.SECUREFORGE_WORKSPACE ?? process.cwd(),
    port: Number(process.env.SECUREFORGE_MCP_PORT ?? 8792),
  }).then(({ address }) => {
    console.log(`SecureForge read-only MCP bridge listening at http://127.0.0.1:${address.port}/mcp`);
    console.log('No file-write or arbitrary shell tools are exposed. Keep this local.');
  }).catch((err) => { console.error(err.message); process.exitCode = 1; });
}
