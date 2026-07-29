import { Fragment, useState } from 'react'
import type { Agent, AgentRole, EffortLevel, HireProposal, Project, Ticket } from '@shared/types'
import {
  CODEX_LIMITATIONS,
  EFFORT_LADDER_LENGTH,
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  ROLE_DEFS,
  effortDefaultFor,
  effortNoteFor,
  isValidModel,
  modelLabel,
  providerForModel,
  formatTokens,
  prettyModel,
  roleDef,
  supportsEffort,
  tokenBreakdown,
  totalTokens,
} from '@shared/types'
import { Avatar, Button, Empty, Input, Tag } from '../components/ui'
import { useResolvedModels, type ResolvedModels } from '../stores/useResolvedModels'
import { Blueprint } from '../components/ui/Blueprint'
import { Icon } from '../components/ui/Icon'

/**
 * The roster. You build the team; the Pilot assigns work to it.
 *
 * v1's Team tab was read-only — it described roles the Pilot could hire but gave you no way
 * to create anything. This is the screen that fixes that.
 */
export function Team({
  project,
  agents,
  tickets,
  hires,
}: {
  project: Project
  agents: Agent[]
  tickets: Ticket[]
  hires: HireProposal[]
}) {
  const [editing, setEditing] = useState<Agent | 'new' | null>(null)
  const resolved = useResolvedModels(agents)

  const pilot = agents.find((a) => a.isPilot) ?? null
  const roster = agents.filter((a) => !a.isPilot && a.isRoster)
  const adhoc = agents.filter((a) => !a.isPilot && !a.isRoster)

  return (
    <div className="scroll-y" style={{ flex: 1, padding: '20px 20px 28px' }}>
      <div style={{ maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h2 style={{ font: '600 20px var(--font-heading)', margin: 0 }}>Team</h2>
          <span className="meta" style={{ flex: 1 }}>
            {roster.length} teammate{roster.length === 1 ? '' : 's'}
            {adhoc.length > 0 && ` · ${adhoc.length} spawned for one ticket`}
          </span>
          <Button kind="primary" height={28} onClick={() => setEditing('new')}>
            <Icon name="add" size={13} />
            New teammate
          </Button>
        </div>

        {pilot && (
          <Blueprint
            style={{
              border: '1px solid var(--color-accent)',
              padding: '12px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: 11,
            }}
          >
            <Avatar initials="PI" seed={pilot.id} size={28} isPilot />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{pilot.name}</span>
                <span className="cap">orchestrator</span>
                <Tag tone="accent">{prettyModel(pilot.resolvedModel, pilot.model)}</Tag>
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--ink-2)' }}>
                Talks to you, plans the work, assigns it. Cannot edit files — that is deliberate.
              </div>
            </div>
            {totalTokens(pilot) > 0 && (
              <span className="meta tnum" title={tokenBreakdown(pilot)}>
                {formatTokens(totalTokens(pilot))} tok
              </span>
            )}
          </Blueprint>
        )}

        {hires.length > 0 && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="cap">
              {hires.every((h) => h.fromBootstrap)
                ? 'Suggested after looking at your code'
                : 'The Pilot wants to hire'}
            </div>
            <div className="meta" style={{ color: 'var(--faint)', marginBottom: 2 }}>
              Nobody exists until you approve them. You can rename or re-tier first.
            </div>
            {hires.map((h) => (
              <HireCard key={h.id} hire={h} projectId={project.id} resolved={resolved} />
            ))}
          </section>
        )}

        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="cap">Your team</div>
          {roster.length === 0 ? (
            <Empty
              title="No teammates yet"
              hint="Create the people you want on this project. Each gets its own instructions and its own git worktree, so their work never collides. The Pilot assigns tickets to whoever fits."
              action={
                <Button kind="primary" height={30} onClick={() => setEditing('new')}>
                  Create the first one
                </Button>
              }
            />
          ) : (
            roster.map((a) => (
              <TeammateRow
                key={a.id}
                agent={a}
                ticket={tickets.find((t) => t.id === a.currentTicketId) ?? null}
                onEdit={() => setEditing(a)}
                projectId={project.id}
              />
            ))
          )}
        </section>

        {adhoc.length > 0 && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="cap">Spawned for a single ticket</div>
            {adhoc.map((a) => (
              <TeammateRow
                key={a.id}
                agent={a}
                ticket={tickets.find((t) => t.id === a.currentTicketId) ?? null}
                onEdit={() => setEditing(a)}
                projectId={project.id}
              />
            ))}
          </section>
        )}

        <section>
          <div className="cap" style={{ marginBottom: 7 }}>
            What each role is for
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
            {ROLE_DEFS.map((r) => {
              const n = roster.filter((a) => a.role === r.id).length
              return (
                <div
                  key={r.id}
                  style={{
                    border: `1px solid ${n ? 'var(--color-accent)' : 'var(--line)'}`,
                    background: n ? 'var(--color-accent-100)' : 'transparent',
                    padding: '10px 11px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 5,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ font: '600 15px var(--font-heading)' }}>{r.name}</span>
                    {n > 0 && <span className="meta tnum">{n}</span>}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: n ? 'var(--accent-ink)' : 'var(--muted)',
                    }}
                  >
                    {r.blurb}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </div>

      {editing && (
        <TeammateEditor
          projectId={project.id}
          agent={editing === 'new' ? null : editing}
          resolved={resolved}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

/**
 * A hire waiting on you.
 *
 * The Pilot can no longer add people by itself — that was the v1 behaviour that made the
 * team feel like it was happening *to* you. It proposes with a reason; you decide.
 */
export function HireCard({
  hire,
  projectId,
  // The exact version each alias last resolved to, passed down rather than re-derived: it is
  // learned from the agent rows the parent already holds, and this picker should say the same
  // thing the editor does.
  resolved: hireResolved,
}: {
  hire: HireProposal
  projectId: string
  resolved: ResolvedModels
}) {
  const [name, setName] = useState(hire.name)
  const [model, setModel] = useState(hire.model)
  const [busy, setBusy] = useState(false)
  const def = roleDef(hire.role)

  return (
    <Blueprint
      style={{
        border: '1px solid var(--accent)',
        padding: '11px 13px',
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <div style={{ width: 150 }}>
          <Input value={name} onChange={setName} height={26} />
        </div>
        <span className="cap">{def?.name ?? hire.role}</span>
        <div style={{ flex: 1 }} />
        {/*
          A hire is a teammate, so Codex belongs here — it was filtered out, which made this
          picker silently narrower than the one in the editor you land on immediately after.
          One rule, applied everywhere: Codex can be a teammate, never the Pilot.
        */}
        <div style={{ display: 'flex', gap: 4 }}>
          {MODEL_OPTIONS.map((m) => (
            <button
              key={m.id}
              onClick={() => setModel(m.id)}
              title={hireResolved[m.id] ? `${m.label} — currently ${hireResolved[m.id]}` : m.label}
              style={{
                border: `1px solid ${model === m.id ? 'var(--accent)' : 'var(--line)'}`,
                background: model === m.id ? 'var(--color-accent-200)' : 'transparent',
                color: model === m.id ? 'var(--ink)' : 'var(--faint)',
                font: '400 9px var(--font-heading)',
                letterSpacing: '.08em',
                textTransform: 'uppercase',
                padding: '3px 7px',
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="selectable" style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--ink-2)' }}>
        {hire.why}
      </div>

      {hire.instructions && (
        <div
          className="selectable"
          style={{
            fontSize: 11.5,
            lineHeight: 1.5,
            color: 'var(--faint)',
            borderLeft: '2px solid var(--line)',
            paddingLeft: 7,
          }}
        >
          {hire.instructions}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ flex: 1 }} />
        <Button
          kind="primary"
          height={26}
          disabled={busy || !name.trim()}
          onClick={() => {
            setBusy(true)
            void window.vibepilot.hires
              .accept(projectId, hire.id, { name: name.trim(), model })
              .catch(() => setBusy(false))
          }}
        >
          Hire {name.trim() || hire.name}
        </Button>
        <Button
          height={26}
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void window.vibepilot.hires.reject(projectId, hire.id)
          }}
        >
          No thanks
        </Button>
      </div>
    </Blueprint>
  )
}

function TeammateRow({
  agent,
  ticket,
  onEdit,
  projectId,
}: {
  agent: Agent
  ticket: Ticket | null
  onEdit: () => void
  projectId: string
}) {
  const def = roleDef(agent.role)
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        border: '1px solid var(--line)',
        background: 'var(--surface)',
        padding: '10px 12px',
      }}
    >
      <Avatar initials={agent.avatarInitials} seed={agent.id} size={26} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{agent.name}</span>
          <span className="cap">{def?.name ?? agent.role}</span>
          <Tag tone="neutral">{prettyModel(agent.resolvedModel, agent.model)}</Tag>
          {agent.provider === 'codex' && <Tag tone="warn">limited</Tag>}
        </div>
        <div
          className="ellip"
          style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--muted)' }}
          title={agent.instructions || undefined}
        >
          {agent.instructions?.trim()
            ? agent.instructions
            : agent.statusLine ?? 'No special instructions.'}
        </div>
      </div>
      {ticket && <span className="meta tnum">#{ticket.number}</span>}
      {totalTokens(agent) > 0 && (
        <span className="meta tnum" title={tokenBreakdown(agent)}>
          {formatTokens(totalTokens(agent))} tok
        </span>
      )}
      <Button height={26} onClick={onEdit}>
        Edit
      </Button>
      <Button
        kind="ghost"
        height={26}
        title="Remove from the team"
        onClick={() => {
          if (confirm(`Remove ${agent.name} from the team? Any work in progress stops.`)) {
            void window.vibepilot.agents.remove(projectId, agent.id)
          }
        }}
      >
        <Icon name="close" size={12} />
      </Button>
    </div>
  )
}

function TeammateEditor({
  projectId,
  agent,
  resolved,
  onClose,
}: {
  projectId: string
  agent: Agent | null
  resolved: ResolvedModels
  onClose: () => void
}) {
  const [name, setName] = useState(agent?.name ?? '')
  const [role, setRole] = useState<AgentRole>(agent?.role ?? 'builder')
  const [model, setModel] = useState(agent?.model ?? '')
  const [effort, setEffort] = useState<EffortLevel | null>(agent?.effort ?? null)
  const [instructions, setInstructions] = useState(agent?.instructions ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chosen = MODEL_OPTIONS.find((m) => m.id === model)
  /*
   * Ask about the resolved id when we have one, because that is the thing the CLI actually gates
   * on. The alias is only a stand-in for whatever it points at today.
   */
  const modelTakesEffort = supportsEffort(resolved[model] ?? model)
  const provider = providerForModel(model)
  // An id that is not one of our aliases is a pinned version the user typed.
  const pinned = !chosen && model.length > 0
  const canSave = name.trim().length > 0 && isValidModel(model) && !busy

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      if (agent) {
        await window.vibepilot.agents.update(projectId, agent.id, {
          name: name.trim(),
          role,
          provider,
          model,
          effort,
          instructions,
        })
      } else {
        await window.vibepilot.agents.create({
          projectId,
          name: name.trim(),
          role,
          provider,
          model,
          effort,
          instructions,
        })
      }
      onClose()
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'grid',
        placeItems: 'center',
        padding: '52px 24px',
        background: 'color-mix(in srgb, var(--color-neutral-900) 34%, transparent)',
      }}
      onClick={onClose}
    >
      <Blueprint
        style={{
          width: 'min(600px, 100%)',
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-lg)',
          padding: 16,
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'flex', flexDirection: 'column', gap: 13 }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <h2 style={{ font: '600 15px var(--font-heading)', margin: 0 }}>
              {agent ? `Edit ${agent.name}` : 'New teammate'}
            </h2>
            <div style={{ flex: 1 }} />
            <Button kind="ghost" height={24} onClick={onClose}>
              <Icon name="close" size={13} />
            </Button>
          </div>

          <Field label="Name" hint="How you and the Pilot refer to them.">
            <Input value={name} onChange={setName} autoFocus placeholder="Dana" />
          </Field>

          <Field label="Role" hint={roleDef(role)?.blurb}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {ROLE_DEFS.map((r) => (
                <Pill
                  key={r.id}
                  on={role === r.id}
                  onClick={() => {
                    setRole(r.id)
                    if (!instructions.trim()) setInstructions(r.suggestedInstructions)
                  }}
                >
                  {r.name}
                </Pill>
              ))}
            </div>
          </Field>

          <Field label="Model" hint="Chosen per teammate. There is no default.">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {MODEL_OPTIONS.map((m) => (
                <Pill key={m.id} on={model === m.id} onClick={() => setModel(m.id)}>
                  {m.label}
                  {resolved[m.id] && (
                    <span style={{ opacity: 0.6, marginLeft: 5 }}>{prettyModel(resolved[m.id])}</span>
                  )}
                </Pill>
              ))}
            </div>
            {/*
              The exact version, or nothing. An alias means "latest", so the version is only
              knowable once the CLI has run and told us — until then there is no honest thing to
              put here, and a tier blurb in its place was worse than an empty line.
            */}
            {chosen && (
              <div className="meta" style={{ marginTop: 5 }}>
                {resolved[chosen.id]
                  ? `Currently ${resolved[chosen.id]}`
                  : 'Exact version shown once this teammate has run.'}
              </div>
            )}

            {/*
              An alias always means *latest*, which is right almost always and wrong exactly
              when you want to hold a teammate on a specific version to compare against.
              `--model` takes a full name, so this costs nothing but was never exposed.
            */}
            <div style={{ marginTop: 8 }}>
              <div className="cap" style={{ marginBottom: 4 }}>
                or pin an exact version
              </div>
              <Input
                value={pinned ? model : ''}
                onChange={(v) => setModel(v.trim())}
                height={26}
                placeholder="claude-opus-4-8"
              />
              <div
                className="meta"
                style={{ marginTop: 4, color: pinned && !isValidModel(model) ? 'var(--danger)' : 'var(--faint)' }}
              >
                {pinned && !isValidModel(model)
                  ? 'That does not look like a model name. Expected something like claude-opus-4-8.'
                  : 'Pinned models never move. An alias above always resolves to the latest.'}
              </div>
            </div>
          </Field>

          {provider === 'codex' && (
            <div
              style={{
                border: '1px solid color-mix(in oklab, var(--caution) 40%, white)',
                background: 'var(--warn-soft)',
                padding: '8px 10px',
                fontSize: 11.5,
                lineHeight: 1.6,
                color: 'var(--ink-2)',
              }}
            >
              <strong>Codex is a limited teammate.</strong> Better at prose, but:{' '}
              {CODEX_LIMITATIONS.join('; ')}. Good for bounded writing jobs, not long
              multi-turn work.
            </div>
          )}

          <Field
            label="How hard they think"
            hint="Higher levels reason for longer before acting. They cost more and take longer, so raise it where being wrong is expensive rather than everywhere."
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {EFFORT_OPTIONS.map((o, i) => {
                const active = (effort ?? effortDefaultFor(role)) === o.id
                // Nothing this model will honour, so nothing to offer.
                const dead = !modelTakesEffort
                return (
                  <Fragment key={o.id}>
                    {/*
                      Ultracode is not the next rung above Max — the CLI's ladder ends at max, and
                      ultracode is extra-high plus permission to fan out. A rule says "different
                      kind of thing" where sitting sixth in a row said "more than max".
                    */}
                    {i === EFFORT_LADDER_LENGTH && (
                      <span
                        aria-hidden
                        style={{ width: 1, alignSelf: 'stretch', background: 'var(--line)', margin: '0 3px' }}
                      />
                    )}
                    <button
                      onClick={() => !dead && setEffort(o.id)}
                      disabled={dead}
                      title={dead ? `${modelLabel(model)} has no thinking levels` : o.note}
                      style={{
                        border: `1px solid ${active && !dead ? 'var(--accent)' : 'var(--line)'}`,
                        background: active && !dead ? 'var(--color-accent-200)' : 'transparent',
                        color: dead ? 'var(--line)' : active ? 'var(--ink)' : 'var(--faint)',
                        font: '400 10.5px var(--font-heading)',
                        padding: '4px 8px',
                        cursor: dead ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {o.label}
                    </button>
                  </Fragment>
                )
              })}
              {effort !== null && (
                <button
                  onClick={() => setEffort(null)}
                  title={`Follow the ${role} default, which is ${effortDefaultFor(role)}`}
                  style={{
                    border: '1px solid transparent',
                    background: 'transparent',
                    color: 'var(--faint)',
                    font: '400 10.5px var(--font-heading)',
                    padding: '4px 6px',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                >
                  use the default
                </button>
              )}
            </div>
            {/*
              The CLI silently downgrades a level a model cannot do, and the result envelope
              carries no effort field, so an ignored setting is invisible at every layer — you
              would just pay for something that did nothing. Hence saying it here.
            */}
            {effort && effortNoteFor(model, effort) && (
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--caution)', lineHeight: 1.5 }}>
                {effortNoteFor(model, effort)}
              </div>
            )}
            {effort === 'ultracode' && (
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--caution)', lineHeight: 1.5 }}>
                On Ultracode they may run their own fleet of sub-agents on a single ticket. That
                is powerful on hard work and it can multiply what the ticket costs.
              </div>
            )}
          </Field>

          <Field
            label="Instructions"
            hint="Prepended to every turn they take, after the project rules. Be specific — this is how a specialist becomes actually useful."
          >
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="You write all user-facing copy. Plain English, no marketing voice, never the word “seamless”."
              style={{
                width: '100%',
                minHeight: 104,
                padding: '9px 10px',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-neutral-100)',
                color: 'var(--ink)',
                font: '400 11.5px/1.7 ui-monospace, Menlo, Consolas, monospace',
                resize: 'vertical',
                outline: 'none',
              }}
            />
          </Field>

          {error && (
            <div
              className="selectable"
              style={{
                borderLeft: '2px solid var(--danger)',
                paddingLeft: 10,
                fontSize: 12,
                color: 'var(--danger)',
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 7 }}>
            <Button kind="primary" height={30} disabled={!canSave} onClick={() => void save()}>
              {agent ? 'Save changes' : 'Add to the team'}
            </Button>
            <Button height={30} onClick={onClose}>
              Cancel
            </Button>
            <div style={{ flex: 1 }} />
            {!model && <span className="meta">pick a model to continue</span>}
          </div>
        </div>
      </Blueprint>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span className="cap">{label}</span>
      {children}
      {hint && (
        <span className="meta" style={{ lineHeight: 1.5 }}>
          {hint}
        </span>
      )}
    </div>
  )
}

function Pill({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 27,
        padding: '0 11px',
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${on ? 'var(--color-accent)' : 'var(--line)'}`,
        background: on ? 'var(--color-accent-200)' : 'transparent',
        color: on ? 'var(--accent-ink)' : 'var(--ink-2)',
        fontSize: 12,
        fontWeight: on ? 600 : 400,
      }}
    >
      {children}
    </button>
  )
}
