import { useCallback, useEffect, useState } from 'react'
import type { BranchOverview, DoctorReport, Project } from '@shared/types'
import { DEFAULT_MODEL, MODEL_OPTIONS } from '@shared/types'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { CentrePane } from './panes/CentrePane'
import { RightPane } from './panes/RightPane'
import { Doctor } from './components/Doctor'
import { Settings } from './panes/Settings'
import { Empty, Button } from './components/ui'
import { LogoMark } from './components/ui/Logo'
import { useProjectData } from './stores/useProjectData'

/** No default model: an implicit Opus fleet is how you exhaust a rate window unknowingly. */
const MODEL_KEY = 'vibepilot.pilotModel'
const PROJECT_KEY = 'vibepilot.lastProject'

export function App() {
  const [projects, setProjects] = useState<Project[]>([])
  /*
   * Both side panels fold away.
   *
   * The board needs real width and there are two fixed-width rails either side of it — 230px
   * of project list and 306px of agents — neither of which you are reading while you are
   * looking at a card. Remembered, because a preference you have to set every launch is not a
   * preference.
   */
  const [leftCollapsed, setLeftCollapsed] = useState(
    () => localStorage.getItem('vp.left.collapsed') === '1',
  )
  const [rightCollapsed, setRightCollapsed] = useState(
    () => localStorage.getItem('vp.right.collapsed') === '1',
  )
  useEffect(() => {
    localStorage.setItem('vp.left.collapsed', leftCollapsed ? '1' : '0')
  }, [leftCollapsed])
  useEffect(() => {
    localStorage.setItem('vp.right.collapsed', rightCollapsed ? '1' : '0')
  }, [rightCollapsed])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [showDoctor, setShowDoctor] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [loaded, setLoaded] = useState(false)
  /**
   * The Pilot's model, per project.
   *
   * It used to be one global `localStorage` key, so opening a throwaway repo and a business
   * project meant they shared one expensive model. The project row is now the truth and this
   * key is only the fallback for a project that has not chosen — which also keeps whatever the
   * user had already picked rather than resetting everyone to a default.
   */
  const [fallbackModel, setFallbackModel] = useState<string>(() => {
    // A stored preference from before the alias switch (e.g. "claude-sonnet-4-6") names a
    // model that does not exist. Drop it rather than showing "Pick a model" forever.
    const stored = localStorage.getItem(MODEL_KEY)
    return stored && MODEL_OPTIONS.some((m) => m.id === stored) ? stored : DEFAULT_MODEL
  })
  const data = useProjectData(activeId)

  const refreshProjects = useCallback(async () => {
    const list = await window.vibepilot.projects.list()
    setProjects(list)
    setActiveId((cur) => {
      if (cur) return cur
      // Reopen what you were last working on. Validated against the list rather than
      // trusted: the project may have been archived or removed since, in which case fall
      // through to the first one rather than opening nothing.
      const last = localStorage.getItem(PROJECT_KEY)
      if (last && list.some((p) => p.id === last)) return last
      return list[0]?.id ?? null
    })
    setLoaded(true)
  }, [])

  useEffect(() => {
    if (activeId) localStorage.setItem(PROJECT_KEY, activeId)
  }, [activeId])

  useEffect(() => {
    void refreshProjects()
    void window.vibepilot.system.doctor().then((d) => {
      setDoctor(d)
      // Surface a broken toolchain immediately rather than at first spawn.
      if (d.problems.length > 0) setShowDoctor(true)
    })
  }, [refreshProjects])

  /*
   * A settings save has to reach the rest of the app.
   *
   * This list is the only copy of the project row, and everything below reads it as a prop —
   * so without this, pausing from the board updated the database and left the button, the
   * composer and the header showing the old value until something unrelated refreshed them.
   */
  useEffect(
    () =>
      window.vibepilot.bus.subscribe((batch) => {
        if (batch.domain.some((d) => d.type === 'projects:changed')) void refreshProjects()
      }),
    [refreshProjects],
  )

  /*
   * How many open questions each project has.
   *
   * Kept at the app level rather than in useProjectData, because the whole point is the
   * projects you are NOT looking at — a teammate blocked on project B used to be completely
   * invisible while you read project A, and it would sit there burning a model turn per wait.
   */
  const [questionCounts, setQuestionCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    const refresh = (): void => {
      void window.vibepilot.questions.counts().then(setQuestionCounts)
    }
    refresh()
    return window.vibepilot.bus.subscribe((batch) => {
      if (batch.domain.some((e) => e.type === 'questions:changed')) refresh()
    })
  }, [])

  // Clicking the OS notification opens the project the question came from.
  useEffect(() => window.vibepilot.bus.onRevealProject(setActiveId), [])

  /*
   * What git says, for the chip in the title bar.
   *
   * The chip used to render the stored base branch, so a repo checked out on another branch had
   * a chip confidently disagreeing with it. Read once per project rather than polled: a branch
   * you switch to outside the app is not something worth a timer.
   */
  const [branches, setBranches] = useState<BranchOverview | null>(null)
  useEffect(() => {
    if (!activeId) return setBranches(null)
    void window.vibepilot.git.overview(activeId).then(setBranches)
  }, [activeId])

  const addProject = useCallback(async () => {
    const p = await window.vibepilot.projects.pick()
    if (p) {
      await refreshProjects()
      setActiveId(p.id)
    }
  }, [refreshProjects])

  const active = projects.find((p) => p.id === activeId) ?? null
  const model = active?.pilotModel ?? fallbackModel

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        /*
         * No `minWidth` on the shell.
         *
         * It was 900px, which does not shrink the app below that — it makes the *document*
         * 900px wide and gives the whole window a horizontal scrollbar, so dragging the window
         * narrower slid the entire interface sideways instead of reflowing it. The panes below
         * collapse instead, which is the honest way to handle a narrow window.
         */
        overflow: 'hidden',
        background: 'var(--paper)',
      }}
    >
      <TitleBar project={active} branches={branches} onOpenDoctor={() => setShowDoctor(true)} />

      {/* `minWidth: 0` so the centre pane can shrink; without it a flex child refuses to go
          below its content width and the window scrolls sideways instead of reflowing. */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0 }}>
        {!leftCollapsed && (
        <Sidebar
          projects={projects}
          questionCounts={questionCounts}
          activeId={activeId}
          onSelect={setActiveId}
          onAdd={addProject}
          onOpenSettings={() => setShowSettings(true)}
        />
        )}

        {active ? (
          <>
            <CentrePane
              project={active}
              data={data}
              branches={branches}
              leftCollapsed={leftCollapsed}
              rightCollapsed={rightCollapsed}
              onToggleLeft={() => setLeftCollapsed((c) => !c)}
              onToggleRight={() => setRightCollapsed((c) => !c)}
              model={model}
              onModelChange={(m) => {
                setFallbackModel(m)
                localStorage.setItem(MODEL_KEY, m)
                // Written to the project too, so the next repo you open keeps its own choice.
                void window.vibepilot.projects
                  .update(active.id, { pilotModel: m })
                  .then(() => refreshProjects())
              }}
            />
            {/* Keyed for the same reason the tab panes are: the watched-agent drawer and the
                branches tab both hold ids belonging to whichever project was open before. */}
            {!rightCollapsed && <RightPane key={active.id} project={active} data={data} />}
          </>
        ) : (
          <div
            style={{
              flex: 1,
              background: 'var(--surface)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {loaded && (
              <Empty
                icon={<LogoMark size={54} style={{ color: 'var(--line)' }} />}
                title="No project open"
                hint="Point vibePilot at a git repository. The Pilot reads it, plans the work, and delegates to teammates in their own worktrees — nothing touches your main branch until you say so."
                action={
                  <Button kind="primary" height={30} onClick={addProject} style={{ marginTop: 4 }}>
                    Choose a folder
                  </Button>
                }
              />
            )}
          </div>
        )}
      </div>

      {showSettings && active && (
        <Settings
            projects={projects}
          agents={data.agents}
          project={active}
          doctor={doctor}
          onClose={() => setShowSettings(false)}
          onOpenDoctor={() => {
            setShowSettings(false)
            setShowDoctor(true)
          }}
        />
      )}
      {showDoctor && doctor && <Doctor report={doctor} onClose={() => setShowDoctor(false)} />}
    </div>
  )
}
