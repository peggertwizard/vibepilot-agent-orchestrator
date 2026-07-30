// Step 0 spikes 1-3: loopback listen (firewall), HTTP MCP from a spawned claude child,
// bearer-header auth, and --allowedTools wildcard.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The default install location, overridable for anyone whose CLI lives elsewhere. The shipped
// resolver in src/main/providers/process/resolve.ts does the same thing properly.
const CLAUDE =
  process.env.VIBEPILOT_CLAUDE_BIN ?? join(homedir(), '.local', 'bin', 'claude.exe');
const TOKEN = randomBytes(32).toString('base64url');

const log = (...a) => console.log('[spike]', ...a);

// ---------------------------------------------------------------- MCP server
const TOOLS = [
  {
    name: 'ping_vibepilot',
    description: 'Health check. Call this to confirm the vibePilot bridge is reachable.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'Anything at all.' } },
      required: ['note'],
    },
  },
];

let sawInitialize = false;
let sawToolsList = false;
let sawToolCall = null;
let sawAuthFailure = false;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${TOKEN}`) {
    sawAuthFailure = true;
    log('!! auth header mismatch. got:', JSON.stringify(auth));
    res.writeHead(401).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }

    const reply = (result) => {
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
    };

    switch (msg.method) {
      case 'initialize':
        sawInitialize = true;
        log('<- initialize (protocol', msg.params?.protocolVersion + ')');
        return reply({
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'vibepilot', version: '0.0.1' },
        });
      case 'notifications/initialized':
        res.writeHead(202).end();
        return;
      case 'tools/list':
        sawToolsList = true;
        log('<- tools/list');
        return reply({ tools: TOOLS });
      case 'tools/call':
        sawToolCall = msg.params;
        log('<- tools/call', msg.params?.name, JSON.stringify(msg.params?.arguments));
        return reply({
          content: [{ type: 'text', text: 'pong from vibePilot' }],
          structuredContent: { ok: true },
        });
      default:
        log('<- unhandled method', msg.method);
        return reply({});
    }
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  // SPIKE 1: explicit loopback bind, ephemeral port. Watch for a firewall prompt.
  server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
log(`SPIKE 1 OK - listening on 127.0.0.1:${port} (no firewall prompt blocks this call)`);

// ---------------------------------------------------------------- spawn child
const mcpConfig = JSON.stringify({
  mcpServers: {
    vibepilot: {
      type: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: `Bearer ${TOKEN}` },
    },
  },
});

const args = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--strict-mcp-config',
  '--setting-sources', 'project',
  '--mcp-config', mcpConfig,
  '--allowedTools', 'mcp__vibepilot__*',   // SPIKE 3: wildcard
  '--permission-mode', 'bypassPermissions',
  '--model', 'claude-sonnet-4-5',
];

log('spawning claude...');
const child = spawn(CLAUDE, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, NO_COLOR: '1', CI: '1', ELECTRON_RUN_AS_NODE: undefined },
});

let initMcpServers = null;
let initTools = null;
let resultSeen = null;
const dec = new StringDecoder('utf8');
let tail = '';

child.stdout.on('data', (chunk) => {
  tail += dec.write(chunk);
  const lines = tail.split('\n');
  tail = lines.pop() ?? '';
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    let v;
    try { v = JSON.parse(line); } catch { log('garbage stdout:', line.slice(0, 120)); continue; }
    if (v.type === 'system' && v.subtype === 'init') {
      if (!initMcpServers) {
        initMcpServers = v.mcp_servers;
        initTools = v.tools;
        log('system/init  mcp_servers =', JSON.stringify(v.mcp_servers));
        const vp = (v.tools || []).filter((t) => String(t).includes('vibepilot'));
        log('system/init  vibepilot tools visible =', JSON.stringify(vp));
        log('system/init  total tools =', (v.tools || []).length);
      }
    }
    if (v.type === 'result') {
      resultSeen = v;
      log('result:', v.subtype, '| cost', v.total_cost_usd, '| turns', v.num_turns);
      log('result text:', JSON.stringify(String(v.result || '').slice(0, 300)));
    }
  }
});

let stderrBuf = '';
child.stderr.on('data', (c) => { stderrBuf += c.toString(); });

child.stdin.write(JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'Call the ping_vibepilot tool with note="hello". Then reply with exactly the tool output text and nothing else.' }] },
}) + '\n');
child.stdin.end();

const code = await new Promise((r) => child.on('close', r));

// ---------------------------------------------------------------- verdict
console.log('\n================ SPIKE RESULTS ================');
console.log('exit code                :', code);
const mcpOk = initMcpServers?.find((s) => s.name === 'vibepilot')?.status;
console.log('SPIKE 1 loopback listen  : PASS (bound 127.0.0.1:' + port + ')');
console.log('SPIKE 2 mcp status       :', mcpOk === 'connected' ? 'PASS (connected)' : 'FAIL (' + JSON.stringify(mcpOk) + ')');
console.log('        bearer header    :', sawAuthFailure ? 'FAIL (header not honoured)' : (sawInitialize ? 'PASS (honoured)' : 'UNKNOWN (no requests)'));
console.log('        initialize       :', sawInitialize ? 'PASS' : 'FAIL');
console.log('        tools/list       :', sawToolsList ? 'PASS' : 'FAIL');
console.log('        tools/call       :', sawToolCall ? 'PASS (' + sawToolCall.name + ')' : 'FAIL - tool never invoked');
const wildcardOk = (initTools || []).some((t) => String(t).includes('vibepilot'));
console.log('SPIKE 3 allowedTools *   :', wildcardOk ? 'PASS (mcp tool exposed under wildcard)' : 'FAIL - enumerate names instead');
if (stderrBuf.trim()) console.log('\nstderr tail:\n' + stderrBuf.slice(-1500));
console.log('==============================================');

server.close();
process.exit(0);
