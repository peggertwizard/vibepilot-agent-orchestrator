import { useEffect, useState } from 'react'
import type {
  Agent,
  CheckKind,
  DoctorReport,
  Environment,
  Project,
  UpdateState,
} from '@shared/types'
import {
  CHECK_KINDS,
  CONCURRENCY_WARN_ABOVE,
  REVIEW_LADDER,
  CHECK_LABEL,
  ESCALATION_OPTIONS,
  AUTO_START_OPTIONS,
  AUTO_MERGE_OPTIONS,
  MAX_REVIEW_PASSES,
} from '@shared/types'
import { Button, Input, Tabs } from '../components/ui'
import { Blueprint } from '../components/ui/Blueprint'
import { Icon } from '../components/ui/Icon'

/**
 * Settings.
 *
 * The design comp specified a whole screen and v1 built none of it — the gear opened the
 * system check, which is a diagnostic, not settings. Everything here was previously either
 * hardcoded or reachable only by editing files by hand.
 *
 * It is deliberately short. A settings screen that lists every field the schema happens to
 * have is a settings screen nobody reads.
 */
export function Settings({
  project,
  doctor,
  agents,
  onClose,
  onOpenDoctor,
}: {
  project: Project
  doctor: DoctorReport | null
  /** The roster, so the concurrency slider can stop at the number of people you actually have. */
  agents: Agent[]
  onClose: () => void
  onOpenDoctor: () => void
}) {
  const [tab, setTab] = useState<'project' | 'app'>('project')
  const [saved, setSaved] = useState(false)
  /**
   * Closing with edits in the box.
   *
   * The Save button used to sit in the middle of a long scrolling modal, several sections above
   * the end — so the natural way to leave was the Close button at the top, which threw the
   * edits away without a word. A settings screen that silently discards what you typed is
   * worse than one with no Save button at all, because it looks like it worked.
   */
  const [confirmClose, setConfirmClose] = useState(false)

  /**
   * One draft object rather than a field per `useState`.
   *
   * There are ten of these now, and ten pairs of state hooks with ten lines of reset in an
   * effect is where a settings screen starts quietly forgetting one of them.
   */
  const asDraft = (p: Project) => ({
    name: p.name,
    defaultBaseBranch: p.defaultBaseBranch,
    escalation: p.escalation,
    checks: { ...p.checks },
    previewCmd: p.previewCmd ?? '',
    deployNote: p.deployNote ?? '',
    reviewPasses: p.reviewPasses,
    reviewSensitivity: p.reviewSensitivity,
    maxConcurrentAgents: p.maxConcurrentAgents,
    pilotEffort: p.pilotEffort,
    spendCeilingUsd: p.spendCeilingUsd,
  })
  const teammateCount = Math.max(1, agents.filter((a) => !a.isPilot).length)
  const [draft, setDraft] = useState(() => asDraft(project))
  useEffect(() => setDraft(asDraft(project)), [project])

  const [resetNote, setResetNote] = useState<number | null>(null)
  const [binary, setBinary] = useState('')
  useEffect(() => {
    void window.vibepilot.settings.claudeBinary().then((p) => setBinary(p ?? ''))
  }, [])

  const rung = REVIEW_LADDER.find((r) => r.level === draft.reviewSensitivity) ?? REVIEW_LADDER[4]!
  const dirty = JSON.stringify(draft) !== JSON.stringify(asDraft(project))

  const save = async (): Promise<void> => {
    await window.vibepilot.projects.update(project.id, {
      name: draft.name.trim() || project.name,
      defaultBaseBranch: draft.defaultBaseBranch.trim() || project.defaultBaseBranch,
      escalation: draft.escalation,
      checks: draft.checks,
      // Empty means "not configured", which is NULL — not an empty command to try to run.
      previewCmd: draft.previewCmd.trim() || null,
      deployNote: draft.deployNote.trim() || null,
      reviewPasses: draft.reviewPasses,
      reviewSensitivity: draft.reviewSensitivity,
      maxConcurrentAgents: draft.maxConcurrentAgents,
      pilotEffort: draft.pilotEffort,
      spendCeilingUsd: draft.spendCeilingUsd,
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  /** Leaving with edits pending asks; leaving with none just leaves. */
  const attemptClose = (): void => {
    if (dirty) setConfirmClose(true)
    else onClose()
  }

  const setCheck = (kind: CheckKind, v: string): void =>
    setDraft((d) => ({ ...d, checks: { ...d.checks, [kind]: v } }))

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.35)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '48px 20px',
        zIndex: 40,
      }}
      onClick={attemptClose}
    >
      <Blueprint
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        style={{
          width: 'min(680px, 100%)',
          maxHeight: '100%',
          overflowY: 'auto',
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          boxShadow: 'var(--shadow-lg)',
          padding: '18px 20px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Icon name="settings" size={16} color="var(--muted)" />
          <h2 style={{ font: '600 17px var(--font-heading)', margin: 0 }}>Settings</h2>
          <div style={{ flex: 1 }} />
          <Button height={26} onClick={attemptClose}>
            Close
          </Button>
        </div>

        {/*
          Split, because this modal mixed per-project and app-global content with no visible
          seam — the base branch and the Claude binary path sat in the same list, and only one
          of them means anything different in another repo.
        */}
        <Tabs
          tabs={[
            { id: 'project' as const, label: project.name },
            { id: 'app' as const, label: 'vibePilot' },
          ]}
          active={tab}
          onChange={setTab}
          variant="caps"
        />

        {tab === 'project' && (
          <>
            <Section title="Project">
              <Field label="Name">
                <Input
                  value={draft.name}
                  onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
                  height={28}
                />
              </Field>
              <Field
                label="Base branch"
                hint="Teammates branch from this, and merges land here. Nothing reaches it without you."
              >
                <Input
                  value={draft.defaultBaseBranch}
                  onChange={(v) => setDraft((d) => ({ ...d, defaultBaseBranch: v }))}
                  height={28}
                />
              </Field>
              {/*
                "Most agents at once" used to live here. It enforced nothing — the queue that
                would have applied it had no callers — and now it would be meaningless anyway:
                one person takes one ticket, so how much can run at once is how many people are
                on the team. Hire someone to go faster.
              */}
            </Section>

            {/*
              The highest-value thing on this screen. Verification used to be a sentence in a
              rule file that nothing checked, so an agent that verified and one that said it did
              looked identical. Named commands make it checkable — vibePilot runs them.
            */}
            <Section title="How this project is checked">
              <p style={paraStyle}>
                Teammates call <code>run_checks</code> and <strong>vibePilot</strong> runs these,
                so a green result is evidence rather than a claim. Leave one blank and it is
                skipped. Filled in from your <code>package.json</code> when the project was added.
              </p>
              {/*
                Detection runs on project-add, which does nothing for projects that already
                existed. Guessing on open would overwrite an all-blank form, which is a
                legitimate choice — so it is a button rather than an assumption.
              */}
              <div>
                <Button
                  height={24}
                  onClick={() => {
                    void window.vibepilot.projects.detectChecks(project.id).then((p) => {
                      if (p) setDraft(asDraft(p))
                    })
                  }}
                >
                  Detect from package.json
                </Button>
              </div>
              {CHECK_KINDS.map((kind) => (
                <Field key={kind} label={CHECK_LABEL[kind]}>
                  <Input
                    value={draft.checks[kind] ?? ''}
                    onChange={(v) => setCheck(kind, v)}
                    height={28}
                    placeholder={kind === 'test' ? 'npm test' : `npm run ${kind}`}
                  />
                </Field>
              ))}
            </Section>

            <Section title="Seeing a change before you merge it">
              <p style={paraStyle}>
                How to start this project's dev server. vibePilot runs it{' '}
                <strong>in the teammate's worktree</strong>, on its own port, so you can look at
                finished work without merging it and without touching your own checkout.{' '}
                <code>{'{port}'}</code> is replaced with a free one.
              </p>
              <Field label="Preview command">
                <Input
                  value={draft.previewCmd}
                  onChange={(v) => setDraft((d) => ({ ...d, previewCmd: v }))}
                  height={28}
                  placeholder="npm run dev -- -p {port}"
                />
              </Field>
            </Section>

            {/*
              This replaces a single `deployCmd` field whose own hint said it was "stored so
              the Pilot can run it" — it was stored and run by nothing, pasted into a system
              prompt as prose. A project also has more than one place to send things, which one
              field could not express.
            */}
            <Section title="Where finished work goes">
              <EnvironmentsEditor projectId={project.id} />
            </Section>

            <Field label="What deploying does" hint="Plain words. Migrations, caches, anything that surprises people. Teammates read this.">
              <textarea
                value={draft.deployNote}
                onChange={(e) => setDraft((d) => ({ ...d, deployNote: e.target.value }))}
                rows={3}
                placeholder="Builds, pushes to the server, then runs pending database migrations."
                style={textareaStyle}
              />
            </Field>

            <Section title="How much the team decides for itself">
              <Field label="When a teammate is unsure">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {ESCALATION_OPTIONS.map((o) => (
                    <label
                      key={o.id}
                      style={{ display: 'flex', gap: 7, alignItems: 'flex-start', cursor: 'pointer' }}
                    >
                      <input
                        type="radio"
                        checked={draft.escalation === o.id}
                        onChange={() => setDraft((d) => ({ ...d, escalation: o.id }))}
                        style={{ marginTop: 2 }}
                      />
                      <span>
                        <span style={{ fontSize: 12, fontWeight: 500 }}>{o.label}</span>
                        <span className="meta" style={{ display: 'block', lineHeight: 1.5 }}>
                          {o.blurb}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </Field>

              {/*
                The reviewer rule, as a number rather than a sentence.
                It used to be a line of prose in the Pilot's prompt — "something visual, risky,
                or hard to undo earns a reviewer" — under which a pricing card is visual, so a
                one-word copy change was given its own reviewer. The Pilot followed the
                instruction correctly. The instruction was the problem.
              */}
              <Field
                label={`When work gets a reviewer — ${rung.level}. ${rung.label}`}
                hint={
                  rung.level === 1
                    ? 'No reviewer is ever added. You check everything yourself.'
                    : rung.level === 10
                      ? 'Every build gets a second pair of eyes, including copy and single values.'
                      : `A reviewer is added when the work ${rung.when}. ${rung.why}`
                }
              >
                <Slider
                  min={1}
                  max={10}
                  value={draft.reviewSensitivity}
                  onChange={(v) => setDraft((d) => ({ ...d, reviewSensitivity: v }))}
                  leftLabel="Never"
                  rightLabel="Everything"
                />
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {REVIEW_LADDER.filter((r) => r.level > 1 && r.level <= draft.reviewSensitivity).map(
                    (r) => (
                      <span key={r.level} className="meta" style={{ color: 'var(--muted)' }}>
                        · {r.when}
                      </span>
                    ),
                  )}
                </div>
              </Field>

              <Field
                label={`Teammates working at once — ${draft.maxConcurrentAgents}`}
                hint={
                  draft.maxConcurrentAgents > CONCURRENCY_WARN_ABOVE
                    ? 'Above three, your rate limit usually becomes the real cap — work will queue at Anthropic instead of here, which is harder to see.'
                    : 'Anything ready beyond this waits its turn and starts the moment a slot frees.'
                }
              >
                <Slider
                  min={1}
                  max={Math.max(2, teammateCount)}
                  value={draft.maxConcurrentAgents}
                  onChange={(v) => setDraft((d) => ({ ...d, maxConcurrentAgents: v }))}
                  leftLabel="One at a time"
                  rightLabel={`All ${teammateCount}`}
                  warnAbove={CONCURRENCY_WARN_ABOVE}
                />
              </Field>

              <Field
                label={`Review passes before it comes to you — ${
                  draft.reviewPasses === 0 ? 'unlimited' : (draft.reviewPasses ?? MAX_REVIEW_PASSES)
                }`}
                hint={
                  draft.reviewPasses === 0
                    ? 'Unlimited: a reviewer and a builder that disagree will keep going, and each round costs a full turn from both. Nothing will stop them but you.'
                    : 'How many times a reviewer may send work back before vibePilot stops and asks you.'
                }
              >
                {/*
                  The stored value for unlimited is 0, and putting 0 where the slider's minimum
                  is put "Unlimited" at the far LEFT — reading as *fewer* passes than 1, which
                  is the opposite of what it means. The scale is 1 → 9 → unlimited; the storage
                  stays 0 so nothing else has to change.
                */}
                <Slider
                  min={1}
                  max={10}
                  value={draft.reviewPasses === 0 ? 10 : (draft.reviewPasses ?? MAX_REVIEW_PASSES)}
                  onChange={(v) => setDraft((d) => ({ ...d, reviewPasses: v === 10 ? 0 : v }))}
                  leftLabel="1"
                  rightLabel="Unlimited"
                  dangerAt={10}
                />
              </Field>
            </Section>

            <Section title="Starting new work">
              <p style={paraStyle}>
                Whether work begins on its own, or waits for you to press Start. This is a
                separate question from how much a running agent decides for itself — that is
                the escalation setting above.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                {AUTO_START_OPTIONS.map((o) => (
                  <label
                    key={o.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      padding: '7px 9px',
                      border: `1px solid ${
                        project.autoStart === o.id ? 'var(--accent)' : 'var(--line)'
                      }`,
                      background:
                        project.autoStart === o.id ? 'var(--accent-soft)' : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="autoStart"
                      checked={project.autoStart === o.id}
                      onChange={() =>
                        void window.vibepilot.projects.update(project.id, { autoStart: o.id })
                      }
                      style={{ marginTop: 2 }}
                    />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ font: '500 12px var(--font-heading)' }}>{o.label}</span>
                      <span className="meta">{o.blurb}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div style={{ marginTop: 16, marginBottom: 14 }}>
                <div className="cap" style={{ marginBottom: 6 }}>
                  When work is finished
                </div>
                <p style={paraStyle}>
                  Merging is <strong>local</strong> — it changes your base branch on this
                  machine and nothing else. Pushing and deploying stay behind buttons at every
                  setting here, because those are the two that cannot be taken back.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                  {AUTO_MERGE_OPTIONS.map((o) => (
                    <label
                      key={o.id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 8,
                        padding: '7px 9px',
                        border: `1px solid ${
                          project.autoMerge === o.id ? 'var(--accent)' : 'var(--line)'
                        }`,
                        background:
                          project.autoMerge === o.id ? 'var(--accent-soft)' : 'transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="radio"
                        name="autoMerge"
                        checked={project.autoMerge === o.id}
                        onChange={() =>
                          void window.vibepilot.projects.update(project.id, { autoMerge: o.id })
                        }
                        style={{ marginTop: 2 }}
                      />
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ font: '500 12px var(--font-heading)' }}>{o.label}</span>
                        <span className="meta">{o.blurb}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <p style={paraStyle}>
                Pausing stops the <em>next</em> ticket being handed out. Work already running
                carries on and finishes untouched — pause never interrupts anything. There is a
                toggle for this on the board too, which is usually where you want it.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Button
                  height={26}
                  kind={project.launchPaused ? 'primary' : 'ghost'}
                  onClick={() =>
                    void window.vibepilot.projects.update(project.id, {
                      launchPaused: !project.launchPaused,
                    })
                  }
                >
                  {project.launchPaused ? 'Resume starting work' : 'Pause starting work'}
                </Button>
                <span className="meta">
                  {project.launchPaused
                    ? 'Paused — nothing new will start.'
                    : 'Running — ready work starts when a slot is free.'}
                </span>
              </div>
            </Section>

            <Section title="The Pilot, on this project">
              <p style={paraStyle}>
                The model is the picker beside the composer, and it is stored per project — each
                project keeps its own.
              </p>
              {/*
                "How hard it thinks" used to live here. It wrote `pilot_effort`, which no spawn
                path in the main process ever read — the setting did nothing at all. The
                composer's picker writes the agent row, which IS read, so that is now the only
                place it lives. Two controls for one thing, and this was the broken one.
              */}
              <Field
                label="Spend ceiling for this project"
                hint="A backstop under the per-ticket budgets, not a replacement for them. Blank means no ceiling."
              >
                <Input
                  value={draft.spendCeilingUsd === null ? '' : String(draft.spendCeilingUsd)}
                  onChange={(v) =>
                    setDraft((d) => ({
                      ...d,
                      spendCeilingUsd: v.trim() ? Math.max(0, Number(v) || 0) : null,
                    }))
                  }
                  height={28}
                  placeholder="no ceiling"
                />
              </Field>
            </Section>

          </>
        )}

        {tab === 'project' && (
        <Section title="This folder's own Claude settings">
          {/*
            A trust gate, because headless spawning never gets one.
            Interactive Claude Code asks before it trusts a directory. vibePilot spawns with
            `-p`, which shows no dialog, and with permissions bypassed — so honouring a folder's
            `.claude/settings.json` unconditionally meant a SessionStart hook in any repository
            you added ran its command at spawn. Cloning was enough. Verified against CLI 2.1.220.
          */}
          <p style={paraStyle}>
            A project folder can contain its own <code>.claude/settings.json</code>. That file can
            run commands automatically whenever an agent starts. vibePilot ignores it unless you
            say this folder is trusted.
          </p>
          <p style={paraStyle}>
            Leave this off for anything you did not write yourself. Turning it on for a repository
            someone else wrote means running their commands on your machine.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <Button
              height={26}
              kind={project.settingsTrusted ? 'ghost' : 'primary'}
              onClick={() =>
                void window.vibepilot.projects.update(project.id, {
                  settingsTrusted: !project.settingsTrusted,
                })
              }
            >
              {project.settingsTrusted ? 'Stop trusting this folder' : 'Trust this folder'}
            </Button>
            <span className="meta">
              {project.settingsTrusted
                ? 'Trusted — this folder’s Claude settings are loaded.'
                : 'Not trusted — this folder’s Claude settings are ignored.'}
            </span>
          </div>
        </Section>
        )}

        {tab === 'project' && (
        <Section title="Files vibePilot keeps in your repo">
          <p style={paraStyle}>
            <code>.vibepilot/pilot.md</code> is the Pilot's brief, <code>.vibepilot/rules/</code>{' '}
            holds the rules every teammate is bound by, and <code>.vibepilot/memory/</code> is
            what the project has learned. They live in the repo on purpose: they are project
            decisions, so they should be version-controlled, reviewable and diffable. Edit them
            in your editor.
          </p>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button
              height={26}
              onClick={() => void window.vibepilot.system.revealInExplorer(`${project.path}/.vibepilot`)}
            >
              Open .vibepilot
            </Button>
            <Button height={26} onClick={() => void window.vibepilot.memory.openFolder(project.id)}>
              Open memory
            </Button>
          </div>
        </Section>
        )}

        {tab === 'app' && (
          <>
        <Section title="Updates">
          <UpdatePanel />
        </Section>

        <Section title="Token counting">
          <p style={paraStyle}>
            Counters add up for as long as a teammate exists. Resetting starts them again from
            zero for <strong>{project.name}</strong> — useful when you want to see what something
            costs from now rather than since the beginning. Nothing else is touched: tickets,
            messages and history all stay exactly as they are.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Button
              height={26}
              onClick={() => {
                void window.vibepilot.agents.resetUsage(project.id).then((n) => setResetNote(n))
              }}
            >
              Reset counters for this project
            </Button>
            {resetNote !== null && (
              <span className="meta">
                Reset — {resetNote} {resetNote === 1 ? 'teammate' : 'teammates'} back to zero.
              </span>
            )}
          </div>
        </Section>

        <Section title="Where Claude is">
          <p style={paraStyle}>
            vibePilot finds your <code>claude</code> executable on PATH. Set a path here when it
            cannot — this is the field the system check has always told you to use.
          </p>
          <Field label="Claude binary path" hint="Leave blank to let vibePilot find it.">
            <div style={{ display: 'flex', gap: 6 }}>
              <Input value={binary} onChange={setBinary} height={28} placeholder="found automatically" />
              <Button
                height={28}
                onClick={() => {
                  void window.vibepilot.settings.setClaudeBinary(binary).then(() => {
                    setSaved(true)
                    setTimeout(() => setSaved(false), 2000)
                  })
                }}
              >
                Set
              </Button>
            </div>
          </Field>
        </Section>

        {/*
          The honest note. Worktree isolation stops teammates colliding with each other and
          with your working tree; it is NOT a security boundary, and saying so plainly is
          better than letting the word "isolated" do work it cannot support.
        */}
        <Section title="What isolation does and does not do">
          <p style={paraStyle}>
            Each teammate works in its own git worktree outside your project folder, so it
            cannot collide with you or with another agent, and nothing reaches your base branch
            until you merge it.
          </p>
          <p style={{ ...paraStyle, color: 'var(--danger)' }}>
            That is not a sandbox. Agents run with <code>bypassPermissions</code>, which
            confines file edits to the worktree but places no limit on <code>Bash</code>: a
            command can reach anything your user account can. Give work to models you would
            give a shell to.
          </p>
        </Section>

        <Section title="Compliance">
          <p style={paraStyle}>
            vibePilot runs <em>your</em> Claude Code CLI as a subprocess. It never sees or
            stores your credentials, and it does not use the Agent SDK — which is not permitted
            with a subscription. <code>npm run compliance</code> fails the build if the SDK ever
            appears in the dependency tree.
          </p>
        </Section>

        <Section title="System">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <KV k="Claude binary" v={doctor?.claudeBinary ?? 'not found'} />
            <KV k="Version" v={doctor?.claudeVersion ?? '—'} />
            <KV k="Git" v={doctor?.gitVersion ?? 'not found'} />
            <KV k="GitHub CLI" v={doctor?.ghVersion ?? 'not installed (optional)'} />
            <KV k="Database" v={doctor?.dbPath ?? '—'} />
            <KV k="Worktrees" v={doctor?.worktreeRoot ?? '—'} />
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <Button height={26} onClick={onOpenDoctor}>
              Run system check
            </Button>
            {doctor?.worktreeRoot && (
              <Button
                height={26}
                onClick={() => void window.vibepilot.system.revealInExplorer(doctor.worktreeRoot)}
              >
                Open worktree folder
              </Button>
            )}
          </div>
          {doctor && doctor.problems.length > 0 && (
            <div style={{ ...paraStyle, color: 'var(--danger)' }}>
              {doctor.problems.length} problem{doctor.problems.length === 1 ? '' : 's'} found —
              open the system check.
            </div>
          )}
        </Section>
          </>
        )}

        {/*
          The save row, at the bottom and stuck there.

          It used to sit in the middle of a long scrolling modal, several sections above the
          end, so the obvious way to leave — the Close button at the top — silently threw the
          edits away. Sticky means it is in the same place whatever you have scrolled to, and
          it says which tab it applies to, because the app-wide fields save themselves.
        */}
        <div
          style={{
            position: 'sticky',
            bottom: -20,
            marginTop: 4,
            marginBottom: -20,
            padding: '12px 0',
            background: 'var(--surface)',
            borderTop: '1px solid var(--line-2)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {confirmClose ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                You have unsaved changes.
              </span>
              <div style={{ flex: 1 }} />
              <Button height={27} onClick={() => setConfirmClose(false)}>
                Keep editing
              </Button>
              {/* Named for what it does. "Cancel" beside "Close" is two words for one idea. */}
              <Button
                height={27}
                onClick={() => {
                  setDraft(asDraft(project))
                  setConfirmClose(false)
                  onClose()
                }}
              >
                Discard them
              </Button>
              <Button
                kind="primary"
                height={27}
                onClick={() => {
                  void save().then(() => {
                    setConfirmClose(false)
                    onClose()
                  })
                }}
              >
                Save and close
              </Button>
            </>
          ) : (
            <>
              {/*
                One big button that says what it is doing, in a colour that means something.
                Grey with nothing to save, accent the moment there is, green when it lands.
                It is the only control down here, so it gets the whole row.
              */}
              <button
                disabled={!dirty}
                onClick={() => void save()}
                style={{
                  flex: 1,
                  height: 40,
                  border: '1px solid',
                  borderColor: saved
                    ? 'var(--ok)'
                    : dirty
                      ? 'var(--accent)'
                      : 'var(--line)',
                  background: saved
                    ? 'var(--ok-soft)'
                    : dirty
                      ? 'var(--accent)'
                      : 'var(--color-neutral-100)',
                  color: saved
                    ? 'var(--color-accent-800)'
                    : dirty
                      ? 'var(--color-neutral-100)'
                      : 'var(--faint)',
                  font: '600 13px var(--font-heading)',
                  letterSpacing: '.02em',
                  cursor: dirty ? 'pointer' : 'default',
                  transition: 'background .12s, border-color .12s, color .12s',
                }}
              >
                {saved
                  ? 'Saved'
                  : dirty
                    ? 'Save changes'
                    : tab === 'app'
                      ? 'These save themselves'
                      : 'Nothing to save'}
              </button>
            </>
          )}
        </div>
      </Blueprint>
    </div>
  )
}


const textareaStyle: React.CSSProperties = {
  width: '100%',
  resize: 'vertical',
  border: '1px solid var(--line)',
  background: 'var(--paper)',
  color: 'var(--ink)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: 1.55,
  padding: 7,
  outline: 'none',
}

const paraStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--ink-2)',
  margin: 0,
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div className="cap">{title}</div>
      {children}
    </section>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--ink)' }}>{label}</label>
      {children}
      {hint && (
        <span className="meta" style={{ color: 'var(--faint)', lineHeight: 1.5 }}>
          {hint}
        </span>
      )}
    </div>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 11.5 }}>
      <span className="meta" style={{ width: 100, flex: 'none' }}>
        {k}
      </span>
      <span className="ellip selectable" style={{ color: 'var(--ink-2)' }} title={v}>
        {v}
      </span>
    </div>
  )
}

/**
 * Updates, on demand.
 *
 * vibePilot checks once at launch and then leaves you alone. Nothing downloads until you press
 * the button, and nothing installs until the app closes — with a hundred-megabyte installer and
 * live agent processes, both of those should be decisions rather than surprises.
 */
function UpdatePanel() {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' })
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    void window.vibepilot.update.state().then(setState)
    void window.vibepilot.update.version().then(setVersion)
    return window.vibepilot.bus.onUpdate(setState)
  }, [])

  const busy = state.phase === 'checking' || state.phase === 'downloading'

  const line = ((): string => {
    switch (state.phase) {
      case 'checking':
        return 'Looking…'
      case 'available':
        return `Version ${state.version} is available. Nothing has been downloaded yet.`
      case 'downloading':
        return `Downloading version ${state.version} — ${state.percent}%.`
      case 'ready':
        return `Version ${state.version} is ready. It installs when you next close vibePilot.`
      case 'none':
        return 'You are on the newest version.'
      case 'error':
        // Not framed as a failure of the app: no network and no published release both land
        // here, and the copy you are running is perfectly good either way.
        return `Could not check just now — ${state.reason}`
      default:
        return 'Not checked yet this session.'
    }
  })()

  return (
    <>
      {/*
        The running version, stated before anything about newer ones. Every other answer in
        this panel is relative to it, and until now it was the one thing the app never said.
      */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          paddingBottom: 8,
          marginBottom: 4,
          borderBottom: '1px solid var(--line-2)',
        }}
      >
        <span className="cap">Running</span>
        <span className="tnum" style={{ font: '500 13px var(--font-heading)' }}>
          {version ? `vibePilot ${version}` : '…'}
        </span>
      </div>
      <p style={paraStyle}>
        vibePilot checks for a new version when it starts. It never downloads or installs
        anything on its own — you press the button. Your projects, tickets and history live
        outside the application folder and an update does not touch them.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        {state.phase === 'available' ? (
          <Button kind="primary" height={26} onClick={() => void window.vibepilot.update.download()}>
            Download {state.version}
          </Button>
        ) : state.phase === 'ready' ? (
          <Button kind="primary" height={26} onClick={() => void window.vibepilot.window.close()}>
            Install and restart
          </Button>
        ) : (
          <Button
            height={26}
            disabled={busy}
            onClick={() => void window.vibepilot.update.check().then(setState)}
          >
            {state.phase === 'checking' ? 'Checking…' : 'Check for updates'}
          </Button>
        )}
        <span className="meta">{line}</span>
      </div>
    </>
  )
}

/**
 * A discrete slider.
 *
 * Native `input[type=range]`, restyled — a hand-rolled drag handle would have to reimplement
 * keyboard support, touch, and the accessibility tree, all of which this gets for nothing.
 *
 * `warnAbove` and `dangerAt` exist because two of these settings have a value that is legal but
 * worth pausing over: more teammates than the rate limit will carry, and a review loop with no
 * end. Colouring the track is quieter than a dialog and harder to miss than a footnote.
 */
function Slider({
  min,
  max,
  value,
  onChange,
  leftLabel,
  rightLabel,
  warnAbove,
  dangerAt,
}: {
  min: number
  max: number
  value: number
  onChange: (v: number) => void
  leftLabel: string
  rightLabel: string
  warnAbove?: number
  dangerAt?: number
}) {
  const danger = dangerAt !== undefined && value === dangerAt
  const warn = warnAbove !== undefined && value > warnAbove
  const accent = danger ? 'var(--danger)' : warn ? 'var(--caution)' : 'var(--accent)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        style={{ width: '100%', accentColor: accent, cursor: 'pointer' }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span className="meta" style={{ color: 'var(--faint)' }}>
          {leftLabel}
        </span>
        <span className="meta" style={{ color: 'var(--faint)' }}>
          {rightLabel}
        </span>
      </div>
    </div>
  )
}

/**
 * The promotion ladder, as rows.
 *
 * Ordering is meaning here: dev sits above production, so the list reads as the sequence work
 * actually travels. "Ask first" defaults on, and for production it is not a preference — the
 * Pilot's `deploy` tool refuses any environment that has it set, at every autonomy level,
 * because deploying is the one action in this app that reaches people other than you.
 */
function EnvironmentsEditor({ projectId }: { projectId: string }) {
  const [envs, setEnvs] = useState<Environment[]>([])
  const [name, setName] = useState('')
  const [cmd, setCmd] = useState('')

  const load = (): void => {
    void window.vibepilot.environments.list(projectId).then(setEnvs)
  }
  useEffect(load, [projectId])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={paraStyle}>
        Each one is a command vibePilot runs in your project folder — the same way it runs your
        checks. Deploy what you have merged, not what is sitting in a worktree.
      </p>

      {envs.map((e) => (
        <div
          key={e.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 9px',
            border: '1px solid var(--line)',
          }}
        >
          <span style={{ font: '600 12px var(--font-heading)', minWidth: 78 }}>{e.name}</span>
          <code style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }} className="ellip">
            {e.cmd}
          </code>
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 5 }}
            title="Off means the Pilot may run it without asking. Leave it on for anything other people see."
          >
            <input
              type="checkbox"
              checked={e.confirm}
              onChange={() => {
                void window.vibepilot.environments
                  .save({ projectId, name: e.name, cmd: e.cmd, confirm: !e.confirm })
                  .then(load)
              }}
            />
            <span className="meta">ask first</span>
          </label>
          <Button
            height={22}
            onClick={() => void window.vibepilot.environments.remove(e.id).then(load)}
          >
            Remove
          </Button>
        </div>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Input value={name} onChange={setName} height={26} placeholder="dev" />
        <Input value={cmd} onChange={setCmd} height={26} placeholder="npm run deploy:dev" />
        <Button
          height={26}
          disabled={!name.trim() || !cmd.trim()}
          onClick={() => {
            void window.vibepilot.environments
              .save({ projectId, name: name.trim(), cmd: cmd.trim(), position: envs.length })
              .then(() => {
                setName('')
                setCmd('')
                load()
              })
          }}
        >
          Add
        </Button>
      </div>
    </div>
  )
}
