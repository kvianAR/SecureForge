import { lstat, opendir, realpath, open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const CODE_EXTENSIONS = new Set([
  '.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.go', '.rs', '.java',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.html', '.css', '.scss', '.json', '.toml',
  '.yaml', '.yml', '.md', '.rst', '.txt', '.sql', '.sh', '.ini', '.cfg', '.xml', '.vue',
]);
// Case-insensitive checks are required even on case-sensitive hosts: projects
// move between Linux and default case-insensitive macOS volumes, where .GIT
// and NODE_MODULES can resolve to sensitive excluded directories.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build',
  'coverage', '.next', '.cache', '.tmp', '__pycache__', '.idea', '.vscode']);
const RESTRICTED_NAMES = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|ed25519)|credentials(?:\..*)?|secrets?(?:\..*)?)$/i;
const RESTRICTED_SUFFIX = /\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|keystore)$/i;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_READ_LINES = 180;
const MAX_SCAN_ENTRIES = 20000;
const MAX_SCAN_DIRECTORIES = 1000;
const READ_CHUNK_BYTES = 64 * 1024;
// macOS 11+ open(2): refuse symlinks in ANY path component, atomically.
// This constant is in Apple's fcntl.h; Node does not currently expose it.
const MAC_OS_O_NOFOLLOW_ANY = 0x20000000;
const DIRECTORY_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const FILE_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
// XNU rejects O_NOFOLLOW and O_NOFOLLOW_ANY together (EINVAL). The latter
// already rejects symlinks at every component, including the final file.
const MAC_FILE_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | MAC_OS_O_NOFOLLOW_ANY;

function safeRelativeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || path.isAbsolute(name)) {
    throw new Error('A nonempty workspace-relative path is required');
  }
  if (redactSecrets(name) !== name) throw new Error('Restricted credential-bearing file path');
  const segments = name.replaceAll('\\', '/').split('/');
  if (segments.some((s) => !s || s === '.' || s === '..')) throw new Error('Unsafe path component');
  if (segments.some((s) => SKIP_DIRS.has(s.toLowerCase()) || RESTRICTED_NAMES.test(s) || RESTRICTED_SUFFIX.test(s))) {
    throw new Error('Restricted file path');
  }
  return segments.join('/');
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function redactSecrets(content) {
  return content
    .replace(/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    // Inline assignments: horizontal whitespace only. Never consume the next
    // line's key as a value of an empty credential (e.g. password:\napi_key: x).
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)["']?[ \t]*[:=][ \t]*["']?)([^\s"',;]+)/gi, '$1[REDACTED]')
    // A multiline scalar must be indented and must not itself be an assignment.
    // Preserve the newline so line evidence retains source line numbers.
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)["']?[ \t]*[:=][ \t]*\r?\n[ \t]+["']?)(?![\w.-]+["']?[ \t]*[:=])([^\s"',;]+)/gi, '$1[REDACTED]');
}

// Proposal-only screening. A generated masking test may use a literal
// sentinel such as {"password": "***"} or {"api_key": 0}. The broad
// read/search redactor intentionally treats those as credentials. Exempt
// only these exact, non-secret sentinel values when screening *proposed*
// bytes; never exempt arbitrary strings, numeric PINs, token signatures,
// source reads, model context, or previously existing credential content.
// This function never changes the bytes stored for the proposed edit.
const PROPOSAL_EXAMPLE_ASSIGNMENT =
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)["']?[ \t]*[:=][ \t]*(?:(["'])([^"'\r\n]*)\1|([^\s"',;}\])]+))(?=[ \t]*(?:[,;})\]]|#|\/\/|\r?\n|$))/gi;
const SAFE_EXAMPLE_VALUES = new Set(['***', '0', 'None', 'null', 'True', 'False', '[REDACTED]']);

export function hasProposedCredentialContent(content) {
  if (typeof content !== 'string') throw new TypeError('Proposed content must be text');
  const screened = content.replace(PROPOSAL_EXAMPLE_ASSIGNMENT, (match, quote, quoted, unquoted) => {
    // A sentinel must be the entire literal value. Do not exempt a safe
    // prefix followed by string concatenation or another expression.
    const literal = quoted ?? unquoted;
    return SAFE_EXAMPLE_VALUES.has(literal) ? '[SAFE_TEST_SENTINEL]' : match;
  });
  return redactSecrets(screened) !== screened;
}

export class Workspace {
  constructor(root) {
    if (!root || typeof root !== 'string') throw new Error('Workspace root is required');
    this.requestedRoot = path.resolve(root);
    this.root = null;
    this.rootHandle = null;
  }

  async init() {
    this.root = await realpath(this.requestedRoot);
    if (!(await lstat(this.root)).isDirectory()) throw new Error('Workspace root is not a directory');
    // Keep the root directory descriptor pinned on Linux so every subsequent
    // component can be opened relative to a trusted, already-open directory.
    if (process.platform === 'linux') {
      this.rootHandle = await open(this.root, DIRECTORY_OPEN_FLAGS);
    } else if (process.platform === 'darwin') {
      // A root descriptor is unnecessary on macOS: individual file opens use
      // O_NOFOLLOW_ANY, which protects every path component atomically.
      // Do not combine it with O_NOFOLLOW: XNU returns EINVAL for that pair.
    } else {
      throw new Error('Race-resistant workspace reads require Linux or macOS');
    }
    return this;
  }

  async close() {
    if (this.rootHandle) {
      const handle = this.rootHandle;
      this.rootHandle = null;
      await handle.close();
    }
  }

  #requireRoot() {
    if (!this.root) throw new Error('Call workspace.init() first');
  }

  async #openWorkspaceFile(relPath) {
    this.#requireRoot();
    const rel = safeRelativeName(relPath);
    const candidate = path.resolve(this.root, rel);
    const within = path.relative(this.root, candidate);
    if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('Path leaves workspace');

    if (process.platform === 'darwin') {
      // The kernel resolves every component with O_NOFOLLOW_ANY, including
      // parents; unlike prechecking with lstat(), this closes swap races.
      try {
        return { handle: await open(candidate, MAC_FILE_OPEN_FLAGS), relative: rel };
      } catch (err) {
        if (err.code === 'ELOOP') throw new Error('Symlink access is not permitted');
        throw err;
      }
    }

    // Linux: /proc/self/fd/N anchors each lookup to an open directory fd.
    // The fd is pinned even when another process renames/replaces a path;
    // O_NOFOLLOW prevents symlinks at every newly opened component.
    // Fail closed if procfs is unavailable. No unguarded pathname fallback.
    if (!this.rootHandle) throw new Error('Workspace root descriptor is closed');
    const segments = rel.split('/');
    const directoryHandles = [];
    try {
      let parentFd = this.rootHandle.fd;
      for (const component of segments.slice(0, -1)) {
        const dir = await open(`/proc/self/fd/${parentFd}/${component}`, DIRECTORY_OPEN_FLAGS);
        directoryHandles.push(dir);
        parentFd = dir.fd;
      }
      const handle = await open(`/proc/self/fd/${parentFd}/${segments.at(-1)}`, FILE_OPEN_FLAGS);
      return { handle, relative: rel };
    } catch (err) {
      if (err.code === 'ELOOP' || err.code === 'ENOTDIR') throw new Error('Symlink or non-directory component is not permitted');
      throw err;
    } finally {
      for (const dir of directoryHandles.reverse()) await dir.close();
    }
  }

  async #readRaw(relPath) {
    const { handle, relative } = await this.#openWorkspaceFile(relPath);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Not a regular file');
      if (stat.size > MAX_FILE_BYTES) throw new Error('File exceeds 256 KiB limit');
      // Read through the same checked descriptor and cap bytes actually read.
      // Size can increase between stat() and read(), so never read unbounded.
      const chunks = [];
      let total = 0;
      while (total <= MAX_FILE_BYTES) {
        const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_FILE_BYTES + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
        if (!bytesRead) break;
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
      if (total > MAX_FILE_BYTES) throw new Error('File exceeds 256 KiB limit');
      const buf = Buffer.concat(chunks, total);
      if (buf.includes(0)) throw new Error('Binary file not supported');
      let decoded;
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        const error = new Error('Unsupported file encoding (expected UTF-8)');
        error.code = 'ERR_UNSUPPORTED_ENCODING';
        throw error;
      }
      return { relative, raw: decoded, hash: sha256(buf) };
    } finally {
      await handle.close();
    }
  }

  async readFile(relPath, { startLine = 1, maxLines = 100 } = {}) {
    if (!Number.isInteger(startLine) || startLine < 1) throw new Error('startLine must be >= 1');
    if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > MAX_READ_LINES) {
      throw new Error(`maxLines must be 1..${MAX_READ_LINES}`);
    }
    const { relative, raw, hash } = await this.#readRaw(relPath);
    // Redact with full-file context before extracting lines. Credentials with
    // a key on one line and a value on the next must not escape in excerpts.
    const masked = redactSecrets(raw);
    const lines = masked.split(/\r?\n/);
    const from = Math.min(startLine - 1, lines.length);
    const selected = lines.slice(from, from + maxLines).map((text, i) => ({
      line: from + i + 1, text,
    }));
    return { path: relative, sha256: hash, startLine: from + 1, endLine: from + selected.length,
      totalLines: lines.length, truncated: from + maxLines < lines.length,
      redacted: masked !== raw, lines: selected };
  }

  async rawForProposal(relPath) {
    return this.#readRaw(relPath);
  }

  async listFiles({ maxFiles = 2500, maxEntries = MAX_SCAN_ENTRIES, maxDirectories = MAX_SCAN_DIRECTORIES, signal } = {}) {
    this.#requireRoot();
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 5000) throw new Error('Invalid maxFiles');
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_SCAN_ENTRIES) throw new Error('Invalid maxEntries');
    if (!Number.isInteger(maxDirectories) || maxDirectories < 1 || maxDirectories > MAX_SCAN_DIRECTORIES) throw new Error('Invalid maxDirectories');
    signal?.throwIfAborted();
    const queue = [''];
    const results = [];
    let scannedEntries = 0;
    let directories = 0;
    while (queue.length && results.length < maxFiles) {
      signal?.throwIfAborted();
      const base = queue.shift();
      directories++;
      const directory = await opendir(path.join(this.root, base), { bufferSize: 32 });
      const entries = [];
      for await (const entry of directory) {
        signal?.throwIfAborted();
        if (++scannedEntries > maxEntries) throw new Error(`Workspace scan entry limit reached (${maxEntries})`);
        entries.push(entry);
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (SKIP_DIRS.has(entry.name.toLowerCase()) || RESTRICTED_NAMES.test(entry.name) ||
            RESTRICTED_SUFFIX.test(entry.name) || redactSecrets(rel) !== rel) continue;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            if (directories + queue.length >= maxDirectories) throw new Error(`Workspace scan directory limit reached (${maxDirectories})`);
            queue.push(rel);
          }
        } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          results.push(rel);
          if (results.length >= maxFiles) break;
        }
      }
    }
    signal?.throwIfAborted();
    return results;
  }

  async searchWorkspace(query, { maxResults = 20, maxFiles = 500, signal } = {}) {
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 120) {
      throw new Error('Search query must contain 2..120 characters');
    }
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
      throw new Error('maxResults must be 1..50');
    }
    const term = query.toLowerCase();
    const all = await this.listFiles({ maxFiles, signal });
    const matches = [];
    for (const file of all) {
      signal?.throwIfAborted();
      try {
        const { raw, hash } = await this.#readRaw(file);
        // Match only disclosure-safe text so hidden values cannot become a search oracle.
        const safeLines = redactSecrets(raw).split(/\r?\n/);
        for (let i = 0; i < safeLines.length; i++) {
          if (safeLines[i].toLowerCase().includes(term)) {
            matches.push({ path: file, line: i + 1, snippet: safeLines[i].slice(0, 260), sha256: hash });
            if (matches.length >= maxResults) break;
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ERR_UNSUPPORTED_ENCODING' && !/(limit|Binary|Symlink|Restricted)/.test(err.message)) throw err;
      }
      if (matches.length >= maxResults) break;
    }
    signal?.throwIfAborted();
    return { query, searchedFiles: all.length, matches, capped: matches.length === maxResults };
  }

  async lookupSymbol(symbol, options = {}) {
    if (typeof symbol !== 'string' || !/^[A-Za-z_$][\w$]{1,99}$/.test(symbol)) {
      throw new Error('Symbol must be a simple identifier of length 2..100');
    }
    // Lexical candidate lookup, not a language-server or AST definition resolver.
    return this.searchWorkspace(symbol, options);
  }
}
