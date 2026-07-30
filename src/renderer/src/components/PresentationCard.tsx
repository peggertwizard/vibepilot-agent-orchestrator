import { useState } from 'react'
import type { Agent, EffortLevel, StepKind, Ticket, TicketRoute } from '@shared/types'
import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  STEP_BUDGET_USD,
  STEP_LABEL,
  effortDefaultFor,
  prettyModel,
} from '@shared/types'
import { Blueprint } from './ui/Blueprint'
import { Button } from './ui'
import { Icon } from './ui/Icon'

/**
 * What the Pilot proposes, before anything runs.
 *
 * The Pilot still decides — this does not put the choice back on you. What changed is *when*
 * it acts: a route used to be applied the moment the Pilot felt confident, so ticket #1's
 * route is recorded as `auto_accepted: 1` and a teammate was working before anything appeared
 * on screen. Deciding well and acting unannounced are different things.
 *
 * The most valuable line here is the brief. It is the prompt the assignee will actually
 * receive, and reading it is how you catch a job about to cost far more than it should —
 * before it does, rather than after.
 */
export function PresentationCard({
  route,
  ticket,
  agents,
  projectId,
}: {
  route: TicketRoute
  ticket: Ticket
  agents: Agent[]
  projectId: string
}) {
  const [steps, setSteps] = useState(() => route.steps.map((s) => ({ ...s })))
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [improving, setImproving] = useState(false)
  const [improveText, setImproveText] = useState('')

  const agentFor = (id: string | null): Agent | null =>
    id ? (agents.find((a) => a.id === id) ?? null) : null

  const budget = ticket.budgetUsd ?? STEP_BUDGET_USD[steps[0]?.kind ?? 'build']

  const start = async (): Promise<void> => {
    setBusy(true)
    await window.vibepilot.routes
      .accept(
        projectId,
        route.id,
        steps.map((s) => ({
          kind: s.kind,
          note: s.note,
          assigneeAgentId: s.assigneeAgentId,
          brief: s.brief,
          gate: s.gate,
          model: s.model,
          effort: s.effort,
        })),
      )
      .catch(() => setBusy(false))
  }

  const cancel = async (): Promise<void> => {
    setBusy(true)
    await window.vibepilot.routes
      .reject(projectId, route.id, 'Not now.')
      .catch(() => setBusy(false))
  }

  /**
   * Improve is not Edit.
   *
   * Edit is direct manipulation — change the model, drop a step, retype a brief. Improve says
   * what is wrong in one line and asks the Pilot to think again. They fail differently, which
   * is why both exist: you cannot always name the fix, but you can usually name the problem.
   */
  const improve = async (): Promise<void> => {
    const said = improveText.trim()
    if (!said) return
    setBusy(true)
    await window.vibepilot.routes.reject(projectId, route.id, said).catch(() => undefined)
    await window.vibepilot.comms
      .tellPilot(
        projectId,
        `The user turned down your plan for #${ticket.number} and said: "${said}"\n\n` +
          `Propose it again, changed accordingly. If you think they are wrong, say so in one ` +
          `line and propose what they asked for anyway.`,
      )
      .catch(() => undefined)
  }

  return (
    <Blueprint
      style={{
        border: '1px solid var(--accent)',
        background: 'var(--surface)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 11,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="meta tnum">#{ticket.number}</span>
        <span style={{ font: '600 14px var(--font-heading)', flex: 1, minWidth: 0 }}>
          {ticket.title}
        </span>
        <span className="meta" style={{ color: 'var(--faint)' }}>
          ~${budget.toFixed(2)}
        </span>
      </div>

      {route.rationale && (
        <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--ink-2)' }}>
          {route.rationale}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {steps.map((s, i) => {
          const who = agentFor(s.assigneeAgentId)
          return (
            <div
              key={s.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
                paddingLeft: 10,
                borderLeft: `2px solid ${i === 0 ? 'var(--accent)' : 'var(--line)'}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
                <span className="cap">{STEP_LABEL[s.kind]}</span>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                  {who?.name ?? 'nobody yet'}
                </span>
                {who && (
                  <>
                    <span className="meta">{prettyModel(who.resolvedModel, who.model)}</span>
                    <span className="meta" style={{ color: 'var(--faint)' }}>
                      {who.effort ?? effortDefaultFor(who.role)}
                    </span>
                  </>
                )}
              </div>

              {/* The brief. The single most useful thing on this card. */}
              {s.brief ? (
                editing ? (
                  <textarea
                    value={s.brief}
                    onChange={(e) =>
                      setSteps((cur) =>
                        cur.map((x) => (x.id === s.id ? { ...x, brief: e.target.value } : x)),
                      )
                    }
                    rows={4}
                    style={{
                      width: '100%',
                      resize: 'vertical',
                      border: '1px solid var(--line)',
                      background: 'var(--paper)',
                      color: 'var(--ink)',
                      font: 'inherit',
                      fontSize: 11.5,
                      lineHeight: 1.6,
                      padding: 7,
                      outline: 'none',
                    }}
                  />
                ) : (
                  <div
                    className="selectable"
                    style={{
                      fontSize: 11.5,
                      lineHeight: 1.6,
                      color: 'var(--muted)',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {s.brief}
                  </div>
                )
              ) : (
                <div style={{ fontSize: 11.5, color: 'var(--faint)' }}>
                  No brief — they will get the ticket text.
                </div>
              )}

              {editing && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Picker
                    label="who"
                    value={who?.name ?? '—'}
                    options={agents
                      .filter((a) => !a.isPilot && a.isRoster)
                      .map((a) => ({ id: a.id, label: a.name }))}
                    onPick={(id) =>
                      setSteps((cur) =>
                        cur.map((x) => (x.id === s.id ? { ...x, assigneeAgentId: id } : x)),
                      )
                    }
                  />
                  {who && (
                    <>
                      {/*
                        These set the model and effort **for this step**, not for the person.
                        They used to write straight to the roster row, so choosing Opus once
                        made that teammate an Opus teammate for every ticket afterwards — and
                        two live tickets sharing one person overwrote each other.
                      */}
                      <Picker
                        label="model"
                        value={s.model ?? who.model}
                        options={MODEL_OPTIONS.map((m) => ({ id: m.id, label: m.label }))}
                        onPick={(id) =>
                          setSteps((cur) =>
                            cur.map((x) => (x.id === s.id ? { ...x, model: id } : x)),
                          )
                        }
                      />
                      <Picker
                        label="effort"
                        value={s.effort ?? who.effort ?? effortDefaultFor(who.role)}
                        options={EFFORT_OPTIONS.map((e) => ({ id: e.id, label: e.label }))}
                        onPick={(id) =>
                          setSteps((cur) =>
                            cur.map((x) =>
                              x.id === s.id ? { ...x, effort: id as EffortLevel } : x,
                            ),
                          )
                        }
                      />
                    </>
                  )}
                  {steps.length > 1 && (
                    <button
                      onClick={() => setSteps((cur) => cur.filter((x) => x.id !== s.id))}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--faint)',
                        font: '400 10.5px var(--font-heading)',
                        cursor: 'pointer',
                        textDecoration: 'underline',
                      }}
                    >
                      drop this step
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {improving ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div className="cap">what would you change?</div>
          <textarea
            autoFocus
            value={improveText}
            onChange={(e) => setImproveText(e.target.value)}
            placeholder="don't let him read the whole repo — the live page answers it"
            rows={2}
            style={{
              width: '100%',
              resize: 'vertical',
              border: '1px solid var(--line)',
              background: 'var(--paper)',
              color: 'var(--ink)',
              font: 'inherit',
              fontSize: 12,
              lineHeight: 1.6,
              padding: 7,
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 7 }}>
            <Button
              kind="primary"
              height={27}
              disabled={busy || !improveText.trim()}
              onClick={() => void improve()}
            >
              Ask for a new plan
            </Button>
            <Button height={27} onClick={() => setImproving(false)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <Button kind="primary" height={28} disabled={busy} onClick={() => void start()}>
            <Icon name="branch" size={12} />
            Start work
          </Button>
          <Button height={28} disabled={busy} onClick={() => setEditing((e) => !e)}>
            {editing ? 'Done editing' : 'Edit'}
          </Button>
          <Button height={28} disabled={busy} onClick={() => setImproving(true)}>
            Improve
          </Button>
          <div style={{ flex: 1 }} />
          <Button height={28} disabled={busy} onClick={() => void cancel()}>
            Don&rsquo;t start it
          </Button>
        </div>
      )}
    </Blueprint>
  )
}

/** A tiny inline dropdown. The card has three of these and none of them warrant a library. */
function Picker({
  label,
  value,
  options,
  onPick,
}: {
  label: string
  value: string
  options: Array<{ id: string; label: string }>
  onPick: (id: string) => void
}) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span className="meta" style={{ color: 'var(--faint)' }}>
        {label}
      </span>
      <select
        value={options.find((o) => o.label === value || o.id === value)?.id ?? ''}
        onChange={(e) => onPick(e.target.value)}
        style={{
          height: 22,
          border: '1px solid var(--line)',
          background: 'var(--paper)',
          color: 'var(--ink)',
          font: '400 11px var(--font-heading)',
          padding: '0 4px',
          outline: 'none',
        }}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export type { StepKind }
