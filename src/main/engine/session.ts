import { bus } from '../bus'
import { getAgent, setAgentSession } from '../db/repos/agents'
import { addMessage } from '../db/repos/messages'
import { flushWrites } from '../db/writer'

/**
 * Keep the stored resume handle pointed at a session that exists.
 *
 * `agent:started` fires once per process, so vibePilot recorded the session id at launch and
 * assumed it held. `/clear` breaks that assumption: it starts a **new** session, the CLI
 * carries on happily, and the id in the database now names one that has been thrown away. The
 * failure surfaces much later, as a resume that does not resume, with nothing linking it to a
 * slash command typed days earlier.
 *
 * Reading the id off every `agent:done` fixes the whole class rather than that one command,
 * and it is idempotent: when nothing changed, nothing happens.
 *
 * The user is told, because `/clear` is not a small event — everything the agent had learned
 * about the codebase is gone, and the next answer being oddly uninformed deserves an
 * explanation on the timeline rather than a shrug.
 */
export function noteSessionChange(
  projectId: string,
  agentId: string,
  sessionId: string | undefined,
): void {
  if (!sessionId) return

  const agent = getAgent(agentId)
  if (!agent || agent.sessionId === sessionId) return

  setAgentSession(agentId, sessionId)

  // A first id is a launch, not a clear. Only a *replacement* means the conversation was
  // thrown away, and only that is worth a line in the chat.
  if (agent.sessionId) {
    addMessage({
      projectId,
      agentId,
      authorType: 'system',
      kind: 'text',
      body:
        `${agent.name} started a new session — the previous conversation was cleared. ` +
        `Everything they had worked out about this codebase is gone; they begin again from ` +
        `their instructions and the project's memory.`,
    })
    bus.emitDomain({ type: 'messages:changed', projectId })
  }

  flushWrites()
  bus.emitDomain({ type: 'agents:changed', projectId })
}
