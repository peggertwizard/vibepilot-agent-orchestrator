// Step 0 spike 4: --resume with a pre-minted --session-id.
// Q1: is a session created with --session-id resumable from a different process?
// Q2: does --resume require the SAME cwd? (decides whether the reaper may prune worktrees)
// Also: does --append-system-prompt-file exist?
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// The default install location, overridable for anyone whose CLI lives elsewhere.
const CLAUDE =
  process.env.VIBEPILOT_CLAUDE_BIN ?? join(homedir(), '.local', 'bin', 'claude.exe');
const SESSION = randomUUID();
const dirA = mkdtempSync(join(tmpdir(), 'vp-a-'));
const dirB = mkdtempSync(join(tmpdir(), 'vp-b-'));
const log = (...a) => console.log('[spike]', ...a);

function run({ cwd, prompt, sessionId, resume, extraArgs = [] }) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--permission-mode', 'bypassPermissions',
    '--model', 'claude-sonnet-4-5',
    '--disallowedTools', 'Write,Edit,Bash,Read,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite',
    ...(sessionId ? ['--session-id', sessionId] : []),
    ...(resume ? ['--resume', resume] : []),
    ...extraArgs,
  ];
  const child = spawn(CLAUDE, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', CI: '1' } });

  let out = '', err = '', sid = null, resultText = null, isError = null;
  const dec = new StringDecoder('utf8'); let tail = '';
  child.stdout.on('data', (c) => {
    tail += dec.write(c);
    const lines = tail.split('\n'); tail = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.replace(/\r$/, ''); if (!line.trim()) continue;
      out += line + '\n';
      let v; try { v = JSON.parse(line); } catch { continue; }
      if (v.type === 'system' && v.subtype === 'init' && !sid) sid = v.session_id;
      if (v.type === 'result') { resultText = String(v.result ?? ''); isError = v.is_error; }
    }
  });
  child.stderr.on('data', (c) => { err += c.toString(); });
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');
  child.stdin.end();
  return new Promise((r) => child.on('close', (code) => r({ code, sid, resultText, isError, err })));
}

// --- turn 1: create the session in dir A, plant a fact
log('dirA =', dirA);
log('dirB =', dirB);
log('session =', SESSION);
log('--- run 1: create session in dirA ---');
const r1 = await run({
  cwd: dirA, sessionId: SESSION,
  prompt: 'Remember this codeword: PELICAN-42. Just reply "ok".',
});
log('run1 exit', r1.code, '| session_id', r1.sid, '| result:', JSON.stringify(String(r1.resultText).slice(0, 120)));

// --- run 2: resume from a NEW process, SAME cwd
log('--- run 2: resume in dirA (same cwd) ---');
const r2 = await run({
  cwd: dirA, resume: SESSION,
  prompt: 'What was the codeword I told you? Reply with just the codeword.',
});
const sameCwdOk = !r2.isError && /PELICAN-42/i.test(String(r2.resultText));
log('run2 exit', r2.code, '| isError', r2.isError, '| result:', JSON.stringify(String(r2.resultText).slice(0, 200)));
if (r2.err.trim()) log('run2 stderr:', r2.err.slice(-400));

// --- run 3: resume from a DIFFERENT cwd
log('--- run 3: resume in dirB (different cwd) ---');
const r3 = await run({
  cwd: dirB, resume: SESSION,
  prompt: 'What was the codeword I told you? Reply with just the codeword.',
});
const diffCwdOk = !r3.isError && /PELICAN-42/i.test(String(r3.resultText));
log('run3 exit', r3.code, '| isError', r3.isError, '| result:', JSON.stringify(String(r3.resultText).slice(0, 200)));
if (r3.err.trim()) log('run3 stderr:', r3.err.slice(-400));

// --- bonus: does --append-system-prompt-file exist?
const spFile = join(dirA, 'sys.md');
writeFileSync(spFile, 'You always end every reply with the word BANANA.');
log('--- run 4: --append-system-prompt-file probe ---');
const r4 = await run({
  cwd: dirA, prompt: 'Say hi.', extraArgs: ['--append-system-prompt-file', spFile],
});
const spFileOk = r4.code === 0 && !/unknown option|unrecognized/i.test(r4.err);
log('run4 exit', r4.code, '| result:', JSON.stringify(String(r4.resultText).slice(0, 120)));
if (r4.err.trim()) log('run4 stderr:', r4.err.slice(-300));

console.log('\n================ SPIKE 4 RESULTS ================');
console.log('pre-minted --session-id honoured :', r1.sid === SESSION ? 'PASS' : `FAIL (got ${r1.sid})`);
console.log('--resume, SAME cwd              :', sameCwdOk ? 'PASS (context carried)' : 'FAIL');
console.log('--resume, DIFFERENT cwd         :', diffCwdOk ? 'PASS (cwd-independent)' : 'FAIL (cwd-bound!)');
console.log('  => reaper may prune worktrees :', diffCwdOk ? 'YES, resume survives worktree deletion' : 'NO - never prune a stalled agent worktree');
console.log('--append-system-prompt-file     :', spFileOk ? 'EXISTS (no 32KB cmdline ceiling)' : 'ABSENT (must inline / write to file+flag alt)');
console.log('=================================================');
process.exit(0);
