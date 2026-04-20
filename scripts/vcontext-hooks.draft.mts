#!/usr/bin/env node
/**
 * vcontext-hooks.draft.mts — DRAFT migration of the gate section.
 *
 * NOT PRODUCTION. This is a concrete example accompanying
 * `docs/specs/2026-04-20-ts-strict-migration-plan.md`. It demonstrates:
 *   1. `get<T>()` returning `GetResult<T>` — infra errors are a separate
 *      variant the caller MUST handle (the original bug is unrepresentable).
 *   2. `sessionHasSkillUsage()` throws cleanly for the caller to catch,
 *      matching the Constitution §P3 fail-open contract.
 *   3. `handlePreToolGate()` with typed hook-payload discriminated union.
 *
 * Runs on Node 25+ without flags (type-strip native). Node 22-24 needs
 * `--experimental-strip-types`.
 *
 * Scope boundaries (intentional for this draft):
 *   - Only the gate path (current hooks.js L1072-1389).
 *   - `post`, `errorLog`, `enqueueForLater`, `readStdin` are re-declared
 *     here as minimal stubs so the file is self-contained. In the real
 *     migration they come from the already-migrated phase-2 module.
 *   - Recorder / subagent / session-recall code paths are NOT in this
 *     draft.
 */

import { request } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────
// Section A — Core types (would live in `types/hooks.d.mts`)
// ─────────────────────────────────────────────────────────────────────

type Ok<T>  = { readonly ok: true;  readonly value: T };
type Err<E> = { readonly ok: false; readonly error: E };
type Result<T, E> = Ok<T> | Err<E>;

const ok  = <T>(value: T): Ok<T>  => ({ ok: true,  value });
const err = <E>(error: E): Err<E> => ({ ok: false, error });

type GetErrorKind = 'connect' | 'timeout' | 'parse' | 'http_5xx';

type GetError = {
  readonly kind: GetErrorKind;
  readonly path: string;
  readonly message: string;
  readonly status?: number;
};

type GetResult<T> = Result<T, GetError>;

// Branded session ID prevents accidental swaps with other strings.
type SessionId = string & { readonly __brand: 'SessionId' };

type SessionEntry = {
  readonly id: number;
  readonly session: SessionId;
  readonly type: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly at: string;
};

type SessionQueryResult = {
  readonly results: readonly SessionEntry[];
  readonly total?: number;
};

// Hook payload — discriminated by tool_name.
type BashToolInput = {
  readonly command: string;
  readonly description?: string;
};
type WriteToolInput = {
  readonly file_path: string;
  readonly content: string;
};
type EditToolInput = {
  readonly file_path: string;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
};
type NotebookEditToolInput = {
  readonly notebook_path: string;
  readonly new_source: string;
  readonly cell_id?: string;
  readonly cell_type?: 'code' | 'markdown';
};

type PreToolPayload =
  | { readonly tool_name: 'Bash';         readonly tool_input: BashToolInput;         readonly session_id: string; readonly cwd?: string }
  | { readonly tool_name: 'Write';        readonly tool_input: WriteToolInput;        readonly session_id: string; readonly cwd?: string }
  | { readonly tool_name: 'Edit';         readonly tool_input: EditToolInput;         readonly session_id: string; readonly cwd?: string }
  | { readonly tool_name: 'NotebookEdit'; readonly tool_input: NotebookEditToolInput; readonly session_id: string; readonly cwd?: string }
  | { readonly tool_name: string;         readonly tool_input: Readonly<Record<string, unknown>>;
      readonly session_id: string; readonly cwd?: string };

type PreToolHookOutput = {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PreToolUse';
    readonly additionalContext: string;
  };
  readonly continue: false;
  readonly stopReason: string;
};

type GateDecision = {
  readonly blocked: boolean;
  readonly input: string;
};

// ─────────────────────────────────────────────────────────────────────
// Section B — Config constants (unchanged from hooks.js)
// ─────────────────────────────────────────────────────────────────────

const VCONTEXT_PORT = process.env['VCONTEXT_PORT'] ?? '3150';
const VCONTEXT_URL  = `http://127.0.0.1:${VCONTEXT_PORT}`;

const VCTX_ERROR_LOG = '/tmp/vcontext-errors.jsonl';
const AIOS_SKILL_USAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const AIOS_COLD_START_GRACE_MS = 30 * 1000;               // 30s
const AIOS_SESSION_STARTS_DIR  = '/tmp';

// Mutating tools subject to the gate. Extracted for discriminated check.
const WRITE_TOOLS = new Set<string>(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

// ─────────────────────────────────────────────────────────────────────
// Section C — Minimal stubs (real migration: from phase-2 module)
// ─────────────────────────────────────────────────────────────────────

function errorLog(kind: string, detail: unknown): void {
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      kind,
      detail: detail instanceof Error ? detail.message : detail,
    }) + '\n';
    writeFileSync(VCTX_ERROR_LOG, line, { flag: 'a' });
  } catch { /* fail-open on log failure */ }
}

function post(path: string, data: unknown): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const req = request(
      `${VCONTEXT_URL}${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 3000,
      },
      (res) => { res.resume(); res.on('end', () => resolve()); }
    );
    req.on('error',   () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────
// Section D — get<T>() with Result<T, GetError>
// ─────────────────────────────────────────────────────────────────────
//
// Bug history: hooks.js L1101-1102 silently collapsed 3 failure modes
// into `{results:[]}`. Callers could not distinguish "server down"
// from "server returned empty". The AIOS gate at L1355 treated empty
// as "no routing" and BLOCKED every AIOS write during the OOM cascade
// despite 109 historical skill-usage entries.
//
// The new shape makes the bug class unrepresentable: the caller
// cannot read `.value` without narrowing `.ok === true` first, at
// which point infra errors are separated from semantic empty.

function get<T>(path: string): Promise<GetResult<T>> {
  return new Promise((resolve) => {
    const req = request(
      `${VCONTEXT_URL}${path}`,
      { method: 'GET', timeout: 5000 },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => { chunks.push(c); });
        res.on('end',  () => {
          const body = Buffer.concat(chunks).toString();
          if (status >= 500) {
            resolve(err<GetError>({
              kind: 'http_5xx', path, status,
              message: `HTTP ${status}`,
            }));
            return;
          }
          try {
            // Unknown shape from network — narrow at the call site.
            const parsed = JSON.parse(body) as T;
            resolve(ok(parsed));
          } catch {
            resolve(err<GetError>({
              kind: 'parse', path,
              message: `invalid JSON (len=${body.length})`,
            }));
          }
        });
      }
    );
    req.on('error', (e: Error) => {
      resolve(err<GetError>({
        kind: 'connect', path, message: e.message,
      }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(err<GetError>({
        kind: 'timeout', path, message: 'request timed out after 5000ms',
      }));
    });
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────
// Section E — AIOS path/cache helpers (unchanged logic; typed)
// ─────────────────────────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => { chunks.push(c); });
    process.stdin.on('end',  () => resolve(Buffer.concat(chunks).toString('utf-8')));
    setTimeout(() => resolve(Buffer.concat(chunks).toString('utf-8')), 1000);
  });
}

function extractSessionId(input: string): SessionId {
  try {
    const data = JSON.parse(input) as { session_id?: unknown };
    if (typeof data.session_id === 'string' && data.session_id.length > 0) {
      return data.session_id as SessionId;
    }
  } catch { /* fall through */ }
  const envId = process.env['CLAUDE_SESSION_ID'];
  if (typeof envId === 'string' && envId.length > 0) return envId as SessionId;
  return `session-${Date.now()}` as SessionId;
}

function expandHome(p: string): string {
  if (!p) return '';
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

function normalizeForMatch(p: string): string {
  if (!p) return '';
  let s = expandHome(String(p));
  if (s.startsWith('/private/tmp/')) s = '/tmp/' + s.slice('/private/tmp/'.length);
  else if (s === '/private/tmp') s = '/tmp';
  return s;
}

function isAiosConnectedPath(rawPath: string): boolean {
  const p = normalizeForMatch(rawPath);
  if (!p) return false;
  const home = homedir();
  if (p === join(home, 'skills') || p.startsWith(join(home, 'skills') + '/')) return true;
  if (p.startsWith(join(home, 'Library/LaunchAgents/com.vcontext.'))) return true;
  if (p === '/Volumes/VContext' || p.startsWith('/Volumes/VContext/')) return true;
  if (p.startsWith('/tmp/vcontext-') && p.endsWith('.log')) return true;
  return false;
}

const AIOS_BASH_WRITE_VERBS = /\b(rm|mv|cp|mkdir|rmdir|touch|tee|dd|chmod|chown|ln|git\s+(add|commit|push|reset|checkout|rebase|merge|branch|stash|cherry-pick|rm|mv|restore|clean)|launchctl\s+(load|unload|bootstrap|bootout|kickstart|enable|disable)|npm\s+(install|i|uninstall|remove|rm|ci|publish)|yarn\s+(add|remove)|pnpm\s+(add|remove|install)|pip\s+(install|uninstall))\b/;
const AIOS_BASH_REDIRECT = />\s*["']?(~\/skills|\/Users\/mitsuru_nakajima\/skills|~\/Library\/LaunchAgents\/com\.vcontext\.|\/Volumes\/VContext)/i;

function bashCommandTouchesAios(cmd: string): boolean {
  if (!cmd) return false;
  const lower = cmd.toLowerCase();
  const paths = [
    '~/skills/', '/users/mitsuru_nakajima/skills/',
    '~/library/launchagents/com.vcontext.',
    '/users/mitsuru_nakajima/library/launchagents/com.vcontext.',
    '/volumes/vcontext/',
  ];
  if (!paths.some(p => lower.includes(p))) return false;
  if (AIOS_BASH_WRITE_VERBS.test(cmd)) return true;
  if (AIOS_BASH_REDIRECT.test(cmd)) return true;
  return false;
}

function aiosCacheFlagPath(sessionId: SessionId): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9-]/g, '');
  return join(AIOS_SESSION_STARTS_DIR, `vcontext-skill-usage-${safe}.flag`);
}

function aiosSessionStartPath(sessionId: SessionId): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9-]/g, '');
  return join(AIOS_SESSION_STARTS_DIR, `vcontext-session-start-${safe}.flag`);
}

function aiosSessionStartedAt(sessionId: SessionId): number {
  const f = aiosSessionStartPath(sessionId);
  try {
    const t = parseInt(readFileSync(f, 'utf-8').trim(), 10);
    if (Number.isFinite(t) && t > 0) return t;
  } catch { /* first time seeing this session */ }
  const now = Date.now();
  try { writeFileSync(f, String(now), 'utf-8'); } catch { /* best effort */ }
  return now;
}

function aiosCacheRead(sessionId: SessionId): boolean {
  try {
    const f = aiosCacheFlagPath(sessionId);
    const st = statSync(f);
    if (Date.now() - st.mtimeMs < AIOS_SKILL_USAGE_CACHE_TTL_MS) return true;
  } catch { /* not cached */ }
  return false;
}

function aiosCacheWrite(sessionId: SessionId): void {
  try { writeFileSync(aiosCacheFlagPath(sessionId), '1', 'utf-8'); }
  catch { /* best effort — next call just re-queries */ }
}

// ─────────────────────────────────────────────────────────────────────
// Section F — sessionHasSkillUsage — throws cleanly on infra failure
// ─────────────────────────────────────────────────────────────────────
//
// Contract change vs .js version: this function no longer silently
// returns `false` when the server is unreachable. It throws, and
// `handlePreToolGate` catches with fail-open semantics per
// Constitution §P3. The type system enforces this: GetResult<T>
// cannot be read as "empty" — the caller MUST narrow on .ok.

class VcontextInfraError extends Error {
  constructor(public readonly inner: GetError) {
    super(`vcontext unreachable (${inner.kind}): ${inner.message} [${inner.path}]`);
    this.name = 'VcontextInfraError';
  }
}

async function sessionHasSkillUsage(sessionId: SessionId): Promise<boolean> {
  if (aiosCacheRead(sessionId)) return true;

  const r = await get<SessionQueryResult>(
    `/session/${encodeURIComponent(sessionId)}?type=skill-usage&limit=1`
  );

  if (!r.ok) {
    // Caller (handlePreToolGate) catches this and fail-opens.
    throw new VcontextInfraError(r.error);
  }

  // Narrowed: r.value is SessionQueryResult.
  const results = r.value.results;
  if (results.length > 0) {
    aiosCacheWrite(sessionId);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Section G — emitAiosBlock (typed JSON output)
// ─────────────────────────────────────────────────────────────────────

function emitAiosBlock(_toolName: string, reasonJa: string): void {
  const payload: PreToolHookOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        '\n[!] AIOS-connected write detected.\n' +
        '  This session has not consulted `infinite-skills` routing yet.\n' +
        '  Required before any edit under ~/skills, com.vcontext.*,\n' +
        '  /Volumes/VContext, or /tmp/vcontext-*.log.\n\n' +
        '  Options:\n' +
        '  [ ] Consult infinite-skills routing (recommended)\n' +
        '  [ ] Re-run with INFINITE_SKILLS_OK=1 prefix for emergency override',
    },
    continue: false,
    stopReason: reasonJa,
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

// ─────────────────────────────────────────────────────────────────────
// Section H — handlePreToolGate with typed hook payload
// ─────────────────────────────────────────────────────────────────────
//
// Returns GateDecision. Caller (handlePreTool) checks .blocked.
// The discriminated union on tool_name narrows tool_input at the
// branch. A future refactor that drops .notebook_path on
// NotebookEditToolInput would fail at compile time — not at a live
// gate invocation.

async function handlePreToolGate(): Promise<GateDecision> {
  const input = await readStdin();
  if (!input) return { blocked: false, input: '' };

  // Highest-priority escape hatch.
  if (process.env['INFINITE_SKILLS_OK'] === '1') {
    return { blocked: false, input };
  }

  let data: PreToolPayload;
  try {
    // Unknown shape from the network (Claude Code). Narrow below.
    data = JSON.parse(input) as PreToolPayload;
  } catch {
    // Non-JSON stdin: not a real hook invocation — pass through.
    return { blocked: false, input };
  }

  const toolName = data.tool_name;
  const sessionId = extractSessionId(input);

  // Only gate mutating tools.
  const isWriteTool = WRITE_TOOLS.has(toolName);
  const isBash      = toolName === 'Bash';
  if (!isWriteTool && !isBash) return { blocked: false, input };

  // Narrow tool_input via discriminated union.
  let touchesAios = false;
  switch (data.tool_name) {
    case 'Bash':
      touchesAios = bashCommandTouchesAios(data.tool_input.command);
      break;
    case 'Write':
    case 'Edit':
      touchesAios = isAiosConnectedPath(data.tool_input.file_path);
      break;
    case 'NotebookEdit':
      touchesAios = isAiosConnectedPath(data.tool_input.notebook_path);
      break;
    default: {
      // MultiEdit and any future write-tool — fall back to generic lookup.
      const unknownInput = data.tool_input;
      const target =
        (typeof unknownInput['file_path']     === 'string' && unknownInput['file_path'])     ||
        (typeof unknownInput['notebook_path'] === 'string' && unknownInput['notebook_path']) ||
        '';
      touchesAios = target !== '' && isAiosConnectedPath(target);
      break;
    }
  }
  if (!touchesAios) return { blocked: false, input };

  // Cold-start grace.
  const sessionStart = aiosSessionStartedAt(sessionId);
  if (Date.now() - sessionStart < AIOS_COLD_START_GRACE_MS) {
    return { blocked: false, input };
  }

  // Has infinite-skills routing fired? Fail-open on infra error.
  let hasRouted: boolean;
  try {
    hasRouted = await sessionHasSkillUsage(sessionId);
  } catch (e: unknown) {
    // Per Constitution §P3: infra error → fail-open.
    // This is the guard that did NOT fire during the 2026-04-20 cascade
    // because the old .js `get()` never threw. Now it DOES throw.
    errorLog('aios_gate_query_failed',
      e instanceof VcontextInfraError ? e.inner : String(e));
    return { blocked: false, input };
  }
  if (hasRouted) return { blocked: false, input };

  // Fail-closed on policy violation.
  const reason =
    'AIOS-connected write detected. infinite-skills routing has not fired ' +
    'in this session. Consult routing or retry with INFINITE_SKILLS_OK=1.';
  emitAiosBlock(toolName, reason);

  // Best-effort audit record. Fire-and-forget.
  const toolTarget: string =
    data.tool_name === 'Bash'
      ? data.tool_input.command
      : (data.tool_name === 'Write' || data.tool_name === 'Edit')
        ? data.tool_input.file_path
        : data.tool_name === 'NotebookEdit'
          ? data.tool_input.notebook_path
          : '';

  void post('/store', {
    type: 'aios-gate-block',
    content: JSON.stringify({
      session: sessionId,
      tool: toolName,
      target: toolTarget,
      at: new Date().toISOString(),
    }),
    tags: ['aios-gate', 'block', `tool:${toolName}`],
    session: sessionId,
  });

  return { blocked: true, input };
}

// ─────────────────────────────────────────────────────────────────────
// Section I — Main dispatcher stub (for this draft's self-test)
// ─────────────────────────────────────────────────────────────────────
//
// In the real migration this stays in .js until phase 7. For this
// draft, expose just enough to exercise handlePreToolGate end-to-end.

const [command] = process.argv.slice(2);
switch (command) {
  case 'pre-tool':
    handlePreToolGate()
      .then((d) => {
        if (!d.blocked) {
          // Real hook would also call recordEvent('pre-tool', d.input);
          // omitted in this draft.
        }
      })
      .catch(() => process.exit(0));
    break;
  case 'self-test':
    // Smoke probe for health-check.sh — exits 0 if the module loads.
    process.stdout.write('ok\n');
    process.exit(0);
    break;
  default:
    // This draft only handles 'pre-tool' + 'self-test'.
    // All other events still served by vcontext-hooks.js.
    process.exit(0);
}

// Re-exports for use by other .mts files during the migration.
// Type exports are elided at runtime (verbatimModuleSyntax).
export {
  get,
  sessionHasSkillUsage,
  handlePreToolGate,
  VcontextInfraError,
  ok,
  err,
};
export type {
  Result, GetResult, GetError, GetErrorKind,
  SessionId, SessionEntry, SessionQueryResult,
  PreToolPayload, PreToolHookOutput,
  GateDecision,
};
