#!/usr/bin/env node
/**
 * vcontext-hooks.js — Universal context recorder
 *
 * Design principle: record EVERYTHING, filter NOTHING.
 * Session isolation: each entry is tagged with the session_id
 * from Claude Code's stdin JSON. Recall defaults to own session,
 * with opt-in cross-session search.
 */

import { request } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const VCONTEXT_PORT = process.env.VCONTEXT_PORT || '3150';
const VCONTEXT_URL = `http://127.0.0.1:${VCONTEXT_PORT}`;

// ── HTTP helpers ─────────────────────────────────────────────────

function post(path, data) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const req = request(
      `${VCONTEXT_URL}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 3000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { resolve({ raw: Buffer.concat(chunks).toString() }); }
        });
      }
    );
    req.on('error', () => resolve({ _skipped: true }));
    req.on('timeout', () => { req.destroy(); resolve({ _skipped: true }); });
    req.write(body);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve) => {
    const req = request(
      `${VCONTEXT_URL}${path}`,
      { method: 'GET', timeout: 5000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { resolve({ results: [] }); }
        });
      }
    );
    req.on('error', () => resolve({ results: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ results: [] }); });
    req.end();
  });
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    setTimeout(() => resolve(Buffer.concat(chunks).toString('utf-8')), 1000);
  });
}

// ── Extract session ID from stdin JSON ───────────────────────────
// Claude Code includes session_id in every hook payload.
// Use it for session isolation. Fallback to env or timestamp.

function extractSessionId(input) {
  try {
    const data = JSON.parse(input);
    if (data.session_id) return data.session_id;
  } catch {}
  return process.env.CLAUDE_SESSION_ID || `session-${Date.now()}`;
}

// ── Transcript parser — extract AI responses ────────────────────
// Reads the JSONL transcript file and extracts assistant text blocks
// that appeared since the last read position.

function extractNewAssistantMessages(transcriptPath, sessionId) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];

  const posFile = `/tmp/vcontext-transcript-pos-${sessionId.replace(/[^a-zA-Z0-9-]/g, '')}`;
  let lastPos = 0;
  try { lastPos = parseInt(readFileSync(posFile, 'utf-8').trim(), 10) || 0; } catch {}

  let content;
  try { content = readFileSync(transcriptPath, 'utf-8'); } catch { return []; }

  // Read from last position
  const newContent = content.slice(lastPos);
  if (!newContent.trim()) return [];

  const messages = [];
  for (const line of newContent.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d.type !== 'assistant') continue;
      const msg = d.message || {};
      const blocks = msg.content || [];
      if (!Array.isArray(blocks)) continue;
      const texts = blocks
        .filter(b => b && b.type === 'text' && b.text)
        .map(b => b.text);
      if (texts.length > 0) {
        messages.push(texts.join('\n'));
      }
    } catch {}
  }

  // Save new position
  try { writeFileSync(posFile, String(content.length), 'utf-8'); } catch {}

  return messages;
}

// ── Universal recorder ───────────────────────────────────────────

async function recordEvent(eventName) {
  const input = await readStdin();
  if (!input) return;

  const sessionId = extractSessionId(input);

  // Store the raw hook event
  await post('/store', {
    type: eventName,
    content: input.slice(0, 500000),
    tags: [eventName],
    session: sessionId,
  });

  // On user-prompt: skill routing + predictive search
  if (eventName === 'user-prompt') {
    try {
      const data = JSON.parse(input);
      const prompt = data.prompt || data.content || data.message || '';
      if (prompt.length >= 5) {
        // Skill routing: search vcontext for matching skills
        const matched = await get(`/recall?q=${encodeURIComponent(prompt.slice(0, 100))}&type=skill-registry&limit=2`);
        if (matched.results && matched.results.length > 0) {
          const lines = ['[super-skills] Matched skills:'];
          const matchedNames = [];
          for (const r of matched.results.slice(0, 2)) {
            try {
              const skill = JSON.parse(r.content);
              lines.push(`\n### Skill: ${skill.name}`);
              lines.push(skill.full_content || skill.description || '');
              matchedNames.push(skill.name);
            } catch {}
          }
          process.stdout.write(lines.join('\n') + '\n');

          // Record skill usage for effectiveness tracking
          post('/store', {
            type: 'skill-usage',
            content: JSON.stringify({
              skills: matchedNames,
              prompt: prompt.slice(0, 200),
              session: sessionId,
              used_at: new Date().toISOString(),
            }),
            tags: ['skill-usage', ...matchedNames.map(n => 'skill:' + n)],
            session: sessionId,
          }).catch(() => {});
        }
      }
      if (prompt.length >= 15) {
        post('/predictive-search', { prompt: prompt.slice(0, 500), session: sessionId }).catch(() => {});
      }
    } catch {}
  }

  // On tool-use/session-end: extract and store AI response text from transcript
  if (eventName === 'tool-use' || eventName === 'session-end') {
    try {
      const data = JSON.parse(input);
      // transcript_path for intermediate messages
      const transcriptPath = data.transcript_path;
      if (transcriptPath) {
        const aiMessages = extractNewAssistantMessages(transcriptPath, sessionId);
        for (const msg of aiMessages) {
          if (msg.length < 5) continue;
          await post('/store', {
            type: 'assistant-response',
            content: msg.slice(0, 500000),
            tags: ['assistant-response'],
            session: sessionId,
          });
        }
      }
      // last_assistant_message for Stop hook
      if (data.last_assistant_message) {
        await post('/store', {
          type: 'assistant-response',
          content: data.last_assistant_message.slice(0, 500000),
          tags: ['assistant-response', 'final'],
          session: sessionId,
        });
      }

      // On session-end: generate session summary (additive, raw is NOT deleted)
      if (eventName === 'session-end') {
        try {
          const sessionEntries = await get(`/session/${encodeURIComponent(sessionId)}?limit=50`);
          if (sessionEntries.results && sessionEntries.results.length > 5) {
            const types = {};
            const tools = {};
            let errors = 0;
            for (const r of sessionEntries.results) {
              types[r.type] = (types[r.type] || 0) + 1;
              try {
                const d = JSON.parse(r.content);
                if (d.tool_name) tools[d.tool_name] = (tools[d.tool_name] || 0) + 1;
              } catch {}
              if (r.type === 'tool-error') errors++;
            }
            const summary = JSON.stringify({
              session: sessionId,
              entry_count: sessionEntries.results.length,
              event_types: types,
              tools_used: tools,
              errors,
              summarized_at: new Date().toISOString(),
            });
            await post('/store', {
              type: 'session-summary',
              content: summary,
              tags: ['session-summary', 'auto'],
              session: sessionId,
            });
          }
        } catch {}
      }
    } catch {} // Non-fatal
  }

  // Auto-check completions: when AI claims "done", verify automatically
  if (eventName === 'tool-use') {
    try {
      const data = JSON.parse(input);
      const transcriptPath = data.transcript_path;
      if (transcriptPath) {
        // Check the latest assistant message for completion claims
        const posFile = `/tmp/vcontext-completion-check-${sessionId.replace(/[^a-zA-Z0-9-]/g, '')}`;
        let lastCheck = 0;
        try { lastCheck = parseInt(readFileSync(posFile, 'utf-8').trim(), 10) || 0; } catch {}
        // Only check every 60 seconds to avoid spam
        if (Date.now() - lastCheck > 60000) {
          try { writeFileSync(posFile, String(Date.now()), 'utf-8'); } catch {}
          const messages = extractNewAssistantMessages(transcriptPath, sessionId + '-completion');
          const latest = messages[messages.length - 1] || '';
          if (/完了|complete|done|finished|100%|全て.*完了|実装.*済|修正.*済/i.test(latest)) {
            post('/completion-check', { session: sessionId, assistant_message: latest.slice(0, 500) }).catch(() => {});
          }
        }
      }
    } catch {}
  }

  // Check for pending consultations from other AIs (piggyback on tool-use)
  if (eventName === 'tool-use') {
    try {
      await checkPendingConsultations();
    } catch {} // Non-fatal
  }
}

// ── Auto-consult: check for pending consultations ────────────────
// Checks for consultations addressed to this AI model.
// VCONTEXT_MODEL env: claude, codex, cursor, kiro, antigravity
async function checkPendingConsultations() {
  const model = process.env.VCONTEXT_MODEL || 'claude';

  // Check for consultations addressed to this model
  const pending = await get(`/consult/pending?model=${encodeURIComponent(model)}`);
  if (!pending.pending || pending.pending.length === 0) return;

  for (const p of pending.pending.slice(0, 2)) {
    const lines = [
      `[vcontext:consult] Consultation for ${model} (${p.consultation_id}):`,
      `  Question: ${p.query}`,
      p.context ? `  Context: ${String(p.context).slice(0, 200)}` : '',
      `  ${(p.prompt || '').slice(0, 300)}`,
      ``,
      `  To respond, run:`,
      `  curl -s -X POST http://127.0.0.1:${VCONTEXT_PORT}/consult/${p.consultation_id}/response \\`,
      `    -H 'Content-Type: application/json' \\`,
      `    -d '{"model":"${model}","chosen":1,"reasoning":"your reasoning here","confidence":"high"}'`,
    ].filter(Boolean);
    process.stdout.write(lines.join('\n') + '\n');
  }
}

// ── Summarize entry for recall display ───────────────────────────
function summarize(entry) {
  const raw = entry.content || '';
  try {
    const d = JSON.parse(raw);
    const tool = d.tool_name || '';
    const input = d.tool_input || {};
    const prompt = d.prompt || d.content || d.message || '';
    if (entry.type === 'user-prompt') return prompt.slice(0, 200);
    if (entry.type === 'tool-use' || entry.type === 'pre-tool') {
      const cmd = typeof input === 'string' ? input : (input.command || input.file_path || input.pattern || JSON.stringify(input));
      return `${tool}: ${String(cmd).slice(0, 150)}`;
    }
    if (entry.type === 'subagent-start' || entry.type === 'subagent-stop') {
      return `${d.subagent_type || 'agent'}: ${(d.description || '').slice(0, 100)}`;
    }
    if (entry.type === 'session-end') return 'Session ended';
    if (entry.type === 'compact') return 'Context compacted';
    return (tool || prompt || JSON.stringify(d)).slice(0, 150);
  } catch {
    return raw.slice(0, 150);
  }
}

// ── Subagent start: record + context + skills ───────────────────
// Records with agent: tag, injects session context and skill routing
async function handleSubagentStart() {
  const input = await readStdin();
  const sessionId = extractSessionId(input);

  // Parse agent info
  let description = '';
  let agentType = 'agent';
  try {
    const data = JSON.parse(input);
    description = data.description || data.prompt || '';
    agentType = data.subagent_type || 'agent';
  } catch {}

  // 1. Record with agent: tag (distinguishes from main session)
  await post('/store', {
    type: 'subagent-start',
    content: input.slice(0, 10000),
    tags: ['agent', `agent-type:${agentType}`],
    session: sessionId,
  });

  // 2. Skill routing from agent prompt
  const prompt = description;
  if (prompt.length >= 5) {
    try {
      const matched = await get(`/recall?q=${encodeURIComponent(prompt.slice(0, 100))}&type=skill-registry&limit=2`);
      if (matched.results && matched.results.length > 0) {
        const lines = ['[super-skills:agent] Matched skills:'];
        for (const r of matched.results.slice(0, 2)) {
          try {
            const skill = JSON.parse(r.content);
            lines.push(`\n### Skill: ${skill.name}`);
            lines.push(skill.full_content || skill.description || '');
          } catch {}
        }
        process.stdout.write(lines.join('\n') + '\n');
      }
    } catch {}
  }

  // 3. Inject recent session context (lightweight — last 5 entries)
  try {
    const recent = await get(`/recent?n=5&session=${sessionId}`);
    if (recent.results && recent.results.length > 0) {
      const lines = ['[vcontext:agent] Session context:'];
      for (const r of recent.results) {
        const summary = r.reasoning || String(r.content).slice(0, 150);
        lines.push(`- [${r.type}] ${summary}`);
      }
      process.stdout.write(lines.join('\n') + '\n');
    }
  } catch {}

  // 4. Predictive search — agent gathers background info to self-navigate
  if (prompt.length >= 15) {
    post('/predictive-search', { prompt: prompt.slice(0, 500), session: sessionId, source: 'agent' }).catch(() => {});
  }
}

// ── Session recall ───────────────────────────────────────────────
// Reads stdin to get session_id, then:
//   1. Own session context (primary)
//   2. Other sessions summary (secondary, opt-in)

async function handleSessionRecall() {
  const input = await readStdin();
  const sessionId = extractSessionId(input);
  const namespace = process.env.VCONTEXT_NAMESPACE || '';
  const nsParam = namespace ? `&namespace=${namespace}` : '';

  // Own session context
  const own = await get(`/session/${encodeURIComponent(sessionId)}?limit=20`);
  // Recent from all sessions (for cross-session awareness)
  const recent = await get(`/recent?n=10${nsParam}`);
  const stats = await get('/tier/stats');

  const rules = await get('/recall?q=MANDATORY+RULE&type=decision&limit=10');

  const lines = ['## Virtual Context — Session Recall', ''];
  lines.push(`Session: ${sessionId}`);
  lines.push('');

  // Global rules — ALWAYS first
  if (rules.results && rules.results.length > 0) {
    lines.push('### MANDATORY RULES');
    for (const r of rules.results) {
      if (r.status === 'active') {
        lines.push(`- ${r.content}`);
      }
    }
    lines.push('');
  }

  // Own session entries first
  if (own.results && own.results.length > 0) {
    lines.push('### This Session');
    for (const r of own.results) {
      lines.push(`- [${r.type}] ${summarize(r)}`);
    }
    lines.push('');
  }

  // Other sessions (only entries NOT from this session)
  if (recent.results && recent.results.length > 0) {
    const others = recent.results.filter(r => r.session !== sessionId);
    if (others.length > 0) {
      lines.push('### Other Sessions (recent)');
      for (const r of others.slice(0, 5)) {
        const sid = (r.session || '?').slice(0, 8);
        lines.push(`- [${r.type}] (${sid}) ${summarize(r)}`);
      }
      lines.push('');
    }
  }

  // Cross-project knowledge: find relevant decisions/errors from other projects
  try {
    const data = JSON.parse(input);
    const cwd = data.cwd || '';
    const project = cwd.split('/').filter(Boolean).pop() || '';
    if (project) {
      // Search for decisions and errors NOT from this project
      const crossProject = await get(`/recall?q=${encodeURIComponent(project)}&type=decision&limit=5`);
      const crossErrors = await get(`/recall?q=${encodeURIComponent(project)}&type=completion-violation&limit=3`);
      const otherProjectEntries = [
        ...(crossProject.results || []),
        ...(crossErrors.results || []),
      ].filter(r => {
        // Exclude entries from this same project
        try {
          const c = JSON.parse(r.content);
          const entryCwd = c.cwd || '';
          return !entryCwd.includes(project);
        } catch { return true; }
      });
      if (otherProjectEntries.length > 0) {
        lines.push('### Cross-Project Knowledge');
        for (const r of otherProjectEntries.slice(0, 3)) {
          lines.push(`- [${r.type}] ${summarize(r)}`);
        }
        lines.push('');
      }
    }
  } catch {}

  // Skill evolution history — extended skills
  const diffs = await get('/recall?q=skill-diff&type=skill-diff&limit=10');
  if (diffs.results && diffs.results.length > 0) {
    lines.push('### Skill Evolution (recent changes)');
    for (const r of diffs.results.slice(0, 5)) {
      try {
        const d = JSON.parse(r.content);
        lines.push(`- **${d.skill}** (${d.target}): ${d.old_lines}→${d.new_lines} lines [${d.timestamp?.slice(0, 10) || '?'}]`);
        // Show first 3 diff lines as context
        const diffLines = (d.diff || '').split('\n').slice(0, 3);
        for (const dl of diffLines) {
          lines.push(`  ${dl.slice(0, 120)}`);
        }
      } catch {
        lines.push(`- ${r.content.slice(0, 100)}`);
      }
    }
    lines.push('');
  }

  // Skill suggestions from auto-discovery
  const suggestions = await get('/recall?q=skill-suggestion&type=skill-suggestion&limit=3');
  if (suggestions.results && suggestions.results.length > 0) {
    lines.push('### Skill Suggestions');
    for (const r of suggestions.results.slice(0, 2)) {
      try {
        const d = JSON.parse(r.content);
        lines.push(`- ${d.suggestion.slice(0, 200)}`);
      } catch {}
    }
    lines.push('');
  }

  // Skill discoveries from web search
  const discoveries = await get('/recall?q=skill-discovery&type=skill-discovery&limit=3');
  if (discoveries.results && discoveries.results.length > 0) {
    lines.push('### New Patterns Discovered');
    for (const r of discoveries.results.slice(0, 2)) {
      try {
        const d = JSON.parse(r.content);
        lines.push(`- [${d.topic}] ${d.results[0]?.slice(0, 150) || ''}`);
      } catch {}
    }
    lines.push('');
  }

  if (stats.ram) {
    lines.push(`Memory: RAM ${stats.ram.entries} (${stats.ram.size}) | SSD ${stats.ssd?.entries || 0} (${stats.ssd?.size || '0'})`);
  }

  const output = lines.join('\n');
  if (output.trim().length > 50) {
    process.stdout.write(output);
  }

  // Track session-recall as a metric (enables credit savings calculation)
  await post('/store', {
    type: 'session-recall',
    content: JSON.stringify({ output_chars: output.length, session: sessionId, entries_served: (own.results?.length || 0) + (recent.results?.length || 0) }),
    tags: ['session-recall'],
    session: sessionId,
  });
}

// ── Skill context enrichment ─────────────────────────────────────
// When a skill is about to be used, inject its evolution history.
// Called as a separate command: `skill-context <skill-name>`

async function handleSkillContext(skillName) {
  if (!skillName) return;

  // Get past versions of this skill (FTS searches content, not tags)
  const versions = await get(`/recall?q=${encodeURIComponent(skillName)}&type=skill-version&limit=3`);
  const diffs = await get(`/recall?q=${encodeURIComponent(skillName)}&type=skill-diff&limit=3`);

  if ((!versions.results || versions.results.length === 0) && (!diffs.results || diffs.results.length === 0)) return;

  const lines = [`[extended-skill] ${skillName} — evolution context:`];

  if (diffs.results && diffs.results.length > 0) {
    for (const r of diffs.results) {
      try {
        const d = JSON.parse(r.content);
        lines.push(`  [${d.timestamp?.slice(0, 10) || '?'}] ${d.old_lines}→${d.new_lines} lines (${d.target})`);
        const diffLines = (d.diff || '').split('\n').filter(l => l.startsWith('+') || l.startsWith('-')).slice(0, 5);
        for (const dl of diffLines) {
          lines.push(`    ${dl.slice(0, 100)}`);
        }
      } catch {}
    }
  }

  if (versions.results && versions.results.length > 0) {
    lines.push(`  ${versions.results.length} past version(s) stored. Use /recall?q=skill:${skillName}&type=skill-version to retrieve.`);
  }

  process.stdout.write(lines.join('\n') + '\n');
}

// ── Manual CLI commands ──────────────────────────────────────────

async function manualStore(type, content, tagsStr) {
  if (!content) {
    console.error(`Usage: node vcontext-hooks.js store-${type} "content" ["tag1,tag2"]`);
    process.exit(1);
  }
  const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()) : [];
  tags.push(type, 'manual');
  const sessionId = process.env.CLAUDE_SESSION_ID || `manual-${Date.now()}`;
  const result = await post('/store', {
    type,
    content: String(content).slice(0, 500000),
    tags: [...new Set(tags)],
    session: sessionId,
  });
  console.log(JSON.stringify(result, null, 2));
}

// ── Main ─────────────────────────────────────────────────────────
const [command, ...args] = process.argv.slice(2);

switch (command) {
  // Hook events — all go through the universal recorder
  case 'user-prompt':
  case 'pre-tool':
  case 'tool-use':
  case 'tool-error':
  case 'subagent-start':
    handleSubagentStart().catch(() => process.exit(0));
    break;
  case 'subagent-stop':
  case 'notification':
  case 'session-end':
  case 'compact':
  case 'pre-compact':
  case 'permission-request':
  case 'permission-denied':
    recordEvent(command).catch(() => process.exit(0));
    break;

  // Read-side: session recall
  case 'session-recall':
    handleSessionRecall().catch(() => process.exit(0));
    break;
  // Read-side: skill evolution context
  case 'skill-context':
    handleSkillContext(args[0]).catch(() => process.exit(0));
    break;

  // Manual CLI commands
  case 'store-conversation':
    manualStore('conversation', args[0], args[1]).catch(() => process.exit(0));
    break;
  case 'store-decision':
    manualStore('decision', args[0], args[1]).catch(() => process.exit(0));
    break;
  case 'store-error':
    manualStore('error', args[0], args[1]).catch(() => process.exit(0));
    break;
  case 'store-code':
    manualStore('code', args[0], args[1]).catch(() => process.exit(0));
    break;

  default:
    console.log(`vcontext-hooks — Universal context recorder

Record everything, filter nothing. Session-isolated.

Hook events (via wrapper):
  user-prompt, pre-tool, tool-use, tool-error,
  subagent-start, subagent-stop, notification,
  session-end, compact, pre-compact,
  permission-request, permission-denied

Read-side:
  session-recall    Recall own session + other sessions summary

Manual:
  store-conversation "content" ["tags"]
  store-decision "content" ["tags"]
  store-error "content" ["tags"]
  store-code "content" ["tags"]

Server: ${VCONTEXT_URL} (silent skip if down)`);
    break;
}
