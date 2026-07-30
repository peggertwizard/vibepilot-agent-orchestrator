import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { callTool, publicToolDefs, type RunBinding } from './tools'

/**
 * vibePilot's own MCP server, hosted in the Electron main process and handed to every
 * spawned agent via inline `--mcp-config`. This is how an agent moves a ticket, asks you a
 * question, or spawns a colleague.
 *
 * Transport is in-process HTTP on loopback, verified against Claude Code 2.1.220. The
 * alternative — a stdio bridge — costs an extra node.exe per agent that we don't own and
 * can't see, a script that must survive asar packaging, and orphan processes that outlive a
 * main-process crash. HTTP costs one listener.
 *
 * IDENTITY IS THE HEADER, NOT AN ARGUMENT. Each run gets its own bearer token mapped to a
 * binding. No tool takes a `from` or `agent_id` parameter, so an agent physically cannot
 * impersonate another or write to a ticket it doesn't own.
 */
export class VibePilotMcpServer {
  private server: http.Server | null = null
  private tokens = new Map<string, RunBinding>()
  private port: number | null = null

  async listen(): Promise<number> {
    if (this.port) return this.port
    this.server = http.createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      // Explicit loopback, never 0.0.0.0 — that is what keeps Windows Firewall silent.
      this.server!.listen(0, '127.0.0.1', resolve)
    })
    const addr = this.server!.address()
    this.port = typeof addr === 'object' && addr ? addr.port : null
    return this.port!
  }

  get url(): string {
    if (!this.port) throw new Error('MCP server not listening')
    return `http://127.0.0.1:${this.port}/mcp`
  }

  get boundPort(): number | null {
    return this.port
  }

  mintToken(binding: RunBinding): string {
    const token = randomBytes(32).toString('base64url')
    this.tokens.set(token, binding)
    return token
  }

  /** Revoke on run end so a zombie process cannot keep mutating state. */
  revokeRun(runId: string): void {
    for (const [token, b] of this.tokens) {
      if (b.runId === runId) this.tokens.delete(token)
    }
  }

  close(): void {
    this.server?.close()
    this.server = null
    this.port = null
    this.tokens.clear()
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    // DNS-rebinding guard: a browser-originated request would carry an Origin we don't set.
    const origin = req.headers['origin']
    if (origin && !/^https?:\/\/127\.0\.0\.1(:|$)|^https?:\/\/localhost(:|$)/.test(origin)) {
      res.writeHead(403).end()
      return
    }

    const auth = req.headers['authorization']
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null
    const binding = token ? this.tokens.get(token) : undefined
    if (!binding) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: 'unauthorized' }),
      )
      return
    }

    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => {
      body += c
      if (body.length > 8 * 1024 * 1024) req.destroy()
    })
    req.on('end', () => {
      void this.dispatch(body, binding, res)
    })
  }

  private async dispatch(
    body: string,
    binding: RunBinding,
    res: http.ServerResponse,
  ): Promise<void> {
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown> }
    try {
      msg = JSON.parse(body)
    } catch {
      res.writeHead(400).end()
      return
    }

    const reply = (result: unknown): void => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
    }
    const fail = (code: number, message: string): void => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }))
    }

    switch (msg.method) {
      case 'initialize':
        return reply({
          // Echo the client's version rather than pinning ours — the CLI self-updates and
          // negotiated 2025-11-25 at time of writing.
          protocolVersion: (msg.params?.['protocolVersion'] as string) ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'vibepilot', version: '0.1.0' },
        })

      case 'notifications/initialized':
        res.writeHead(202).end()
        return

      case 'ping':
        return reply({})

      case 'tools/list':
        return reply({ tools: publicToolDefs(binding.role) })

      case 'tools/call': {
        const name = msg.params?.['name'] as string
        const args = (msg.params?.['arguments'] ?? {}) as Record<string, unknown>
        try {
          const result = await callTool(name, args, binding)
          return reply(result)
        } catch (e) {
          // Invalid arguments are a real protocol error; policy denials are NOT — those come
          // back as successful results with ok:false so the model reads the reason.
          return fail(-32602, (e as Error).message)
        }
      }

      default:
        return fail(-32601, `Unknown method: ${String(msg.method)}`)
    }
  }
}

export const mcpServer = new VibePilotMcpServer()
