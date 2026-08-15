/**
 * dsh-teacher host plugin.
 *
 * Teacher mode is a session-scoped, log-only state (`teacher/mode` events),
 * folded from the session log so resume/fork recover it. While active, the
 * `teacher:policy` prompt section renders the Socratic contract, the course
 * (parsed from the user's markdown file) drives the tools, and every detected
 * gap is appended as a `teacher/gap` event AND persisted to the durable ledger
 * ($DSH_HOME/state/dsh-teacher/ledger.db). Retesting is on-demand via the
 * `retest` tool / `/retest` command, scheduled by FSRS-5.
 *
 * Model-facing tools stay registered while teacher mode is inactive; entering
 * or leaving mode changes only the prompt section, never the tool catalog.
 *
 * @module dsh-teacher
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

import { parseCurriculum, publicQuestions } from './lib/curriculum.js'
import { loadCourse } from './lib/course-store.js'
import { buildPolicy } from './lib/policy.js'
import { LedgerStore, gapId, GAP_STATUS } from './lib/ledger.js'
import { QuestionStore, questionStoreFilePath, publicQuestion } from './lib/question-store.js'
import { quizProjectionWith } from './lib/quiz-projection.js'
import { foldTeacherState, hasOpenTurn, MODE_EVENT, GAP_EVENT, GRADE_EVENT, QUIZ_EVENT, COURSE_EVENT, QUIZ_RUN_EVENT } from './lib/fold.js'
import { gapProjectionWith } from './lib/gap-projection.js'
import {
  buildGap, gapKindForVerdict, isCorrect, ratingForVerdict, verdictLabel,
} from './lib/grading.js'
import { FSRS, createCard, review } from './lib/fsrs.js'

/**
 * Register dsh-teacher's session event types with the harness persistence
 * catalog. `KNOWN_SESSION_EVENT_TYPES` is a generated Set shared by the
 * persistence read path: a log containing an event type outside it is refused
 * ("unknown to this harness and not marked ignorable") unless the event is
 * marked ignorable, which `session.append` cannot do. Registering at module
 * load makes teacher sessions readable again after restart — for the very
 * first read of a process, the profile-boot registrar (`dsh-teacher/
 * register-events`) runs first (see lib/register-events.js).
 */
for (const type of [MODE_EVENT, GAP_EVENT, GRADE_EVENT, QUIZ_EVENT, COURSE_EVENT, QUIZ_RUN_EVENT]) {
  KNOWN_SESSION_EVENT_TYPES.add(type)
}

export const name = 'dsh-teacher'

/** Required host services: tool registry and system-prompt assembly. */
export const inject = ['tools', 'systemPrompt']

const DEFAULT_FIRST_INTERVAL_DAYS = 1

function nowMs() {
  return Date.now()
}

function ledgerFilePath() {
  // Tests and embedded deployments can redirect the ledger (e.g. a temp file).
  if (process.env.DSH_TEACHER_LEDGER) return process.env.DSH_TEACHER_LEDGER
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'state', 'dsh-teacher', 'ledger.db')
}

/** Read and parse a curriculum markdown file (sandbox-aware when fs is present). */
async function readCourse(ctx, path) {
  let text
  const fs = ctx.get('fs')
  if (fs !== undefined) {
    const target = await fs.resolve(path)
    text = await fs.readText(target)
  } else {
    text = await readFile(path, 'utf8')
  }
  return parseCurriculum(text)
}

/**
 * Session-scoped controller: mode state + loaded course. Mode is folded from
 * the session log; the course is a per-session live object (file contents are
 * not logged).
 */
class TeacherController {
  constructor(ctx) {
    this.ctx = ctx
    // Keyed by the stable session id (a string), not the Session object: the
    // harness may hand out a fresh Agent/Session reference across turns, which
    // made a WeakMap keyed by `agent.session` lose state (intermittent
    // "no course loaded"). Entries are bounded by session count.
    this.sessions = new Map() // sessionId -> { course, coursePath }
    this.pendingIntents = new Map() // sessionId -> { active, narrate }
    this.ledger = null
    this.questionStore = null
    this.fsrs = new FSRS()
  }

  /** Stable per-session state key: the session id (a string). */
  sessionKey(agent) {
    return agent.session.id
  }

  async ledgerHandle() {
    if (this.ledger === null) {
      this.ledger = await LedgerStore.open(ledgerFilePath())
    }
    return this.ledger
  }

  /** Lazy-open the durable SQLite question store (JSON fallback). */
  async storeHandle() {
    if (this.questionStore === null) {
      this.questionStore = await QuestionStore.open(questionStoreFilePath())
    }
    return this.questionStore
  }

  stateOf(agent) {
    return this.sessions.get(this.sessionKey(agent)) ?? null
  }

  courseOf(agent) {
    const cached = this.stateOf(agent)?.course ?? null
    if (cached !== null) return cached
    // Fresh process: reload the persisted course for this workspace from the
    // SQLite question store (legacy v0.2 JSON course imported once as fallback).
    const workspace = this.workspaceOf(agent)
    const restored = this.restoreCourse(workspace)
    if (restored !== null) {
      this.sessions.set(this.sessionKey(agent), {
        course: restored.course,
        coursePath: restored.source ?? 'persisted',
      })
      return restored.course
    }
    return null
  }

  /** Restore a persisted course for a workspace: DB first, legacy JSON fallback. */
  restoreCourse(workspace) {
    const store = this.questionStore?.store
    if (store !== undefined) {
      try {
        const db = store.latestCourse(workspace)
        if (db !== null) return { course: db, source: db.source }
      } catch (error) {
        this.ctx.logger?.warn?.(`dsh-teacher: failed to read course from store: ${error}`)
      }
    }
    try {
      const legacy = loadCourse(workspace)
      if (legacy !== null) {
        // One-time migration: write the legacy JSON course into the DB.
        this.importLegacyCourse(workspace, legacy)
        return { course: legacy, source: 'legacy-import' }
      }
    } catch {
      // Unreadable/corrupt legacy file is treated as no course.
    }
    return null
  }

  /** Fire-and-forget migration of a v0.2 JSON course into the question store. */
  importLegacyCourse(workspace, course) {
    void this.storeHandle().then(({ store }) => {
      store.upsertCourse({
        workspace,
        title: course.title ?? 'untitled',
        source: 'legacy-import',
        questions: course.questions,
      })
    }).catch((error) => {
      this.ctx.logger?.warn?.(`dsh-teacher: failed to import legacy course: ${error}`)
    })
  }

  /**
   * Persist the loaded course to the SQLite store and log its public questions
   * (`teacher/course` event — never answer keys) so the LLM-free quiz popup
   * and the `teacherQuiz` projection can render it without the model.
   */
  async persistCourse(agent, course, source) {
    const workspace = this.workspaceOf(agent)
    let courseId = null
    try {
      const store = await this.storeHandle()
      courseId = store.store.upsertCourse({
        workspace,
        title: course.title ?? 'untitled',
        source: source ?? null,
        questions: course.questions,
      })
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-teacher: failed to persist course: ${error}`)
    }
    try {
      agent.session.append(COURSE_EVENT, {
        courseId,
        title: course.title ?? null,
        source: source ?? null,
        questions: course.questions.map((q) => publicQuestion(q)),
      })
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-teacher: failed to append teacher/course: ${error}`)
    }
  }

  /** Workspace key used to scope the durable ledger. */
  workspaceOf(agent) {
    return agent.session.meta?.cwd ?? agent.session.id
  }

  get(agent) {
    const active = foldTeacherState(agent.session.events).active
    const pending = this.pendingIntents.get(this.sessionKey(agent))
    return pending === undefined ? { active } : { active, pending: pending.active }
  }

  /**
   * Select teacher mode. Between turns the change is appended immediately;
   * during an open turn it stays pending until the next accepted in-turn
   * pre-step (see #flushPending below).
   */
  set(agent, active) {
    const session = agent.session
    const key = this.sessionKey(agent)
    const pending = this.pendingIntents.get(key)
    const target = pending?.active ?? foldTeacherState(session.events).active
    if (active === target) return 'noop'
    if (hasOpenTurn(session.events)) {
      this.pendingIntents.set(key, { active })
      return foldTeacherState(session.events).active === active ? 'cancelled' : 'queued'
    }
    if (active === foldTeacherState(session.events).active) {
      this.pendingIntents.delete(key)
      return 'cancelled'
    }
    try {
      const state = this.stateOf(agent)
      session.append('teacher/mode', {
        active,
        course: state?.course?.title ?? null,
      })
      this.pendingIntents.delete(key)
      return 'committed'
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-teacher: failed to append teacher/mode: ${error}`)
      this.pendingIntents.set(key, { active })
      return 'queued'
    }
  }

  /** Apply one pending selection before the next request assembly. */
  flushPending(agent) {
    const key = this.sessionKey(agent)
    const pending = this.pendingIntents.get(key)
    if (pending === undefined) return
    if (pending.active === foldTeacherState(agent.session.events).active) {
      this.pendingIntents.delete(key)
      return
    }
    try {
      const state = this.stateOf(agent)
      agent.session.append('teacher/mode', {
        active: pending.active,
        course: state?.course?.title ?? null,
      })
      this.pendingIntents.delete(key)
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-teacher: failed to flush teacher/mode: ${error}`)
    }
  }

  /** Toggle quick-test mode (log-only `teacher/quiz` event). */
  setQuiz(agent, active) {
    try {
      agent.session.append('teacher/quiz', { active })
      return 'committed'
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-teacher: failed to append teacher/quiz: ${error}`)
      return 'queued'
    }
  }

  /** Wrong questions so far in this course, from the durable gap ledger. */
  async wrongQuestions(agent) {
    const state = this.stateOf(agent)
    if (state === null) throw new Error('no course loaded')
    const workspace = this.workspaceOf(agent)
    const courseTitle = state.course.title ?? 'untitled'
    const ledger = await this.ledgerHandle()
    const gaps = ledger.store.listGaps({ workspace, course: courseTitle })
    const open = gaps.filter((g) => g.status === GAP_STATUS.open)
    const byQuestion = new Map()
    for (const gap of open) {
      if (!byQuestion.has(gap.questionId)) byQuestion.set(gap.questionId, [])
      byQuestion.get(gap.questionId).push({
        id: gap.id,
        topic: gap.topic,
        kind: gap.kind,
        evidence: gap.evidence,
      })
    }
    return {
      questionIds: [...byQuestion.keys()],
      questions: [...byQuestion.entries()].map(([questionId, gaps]) => ({
        questionId,
        gaps,
      })),
      openCount: open.length,
    }
  }

  /** Ledger summary for the end-of-session knowledge-point report. */
  async summary(agent) {
    const state = this.stateOf(agent)
    if (state === null) throw new Error('no course loaded')
    const workspace = this.workspaceOf(agent)
    const courseTitle = state.course.title ?? 'untitled'
    const ledger = await this.ledgerHandle()
    const gaps = ledger.store.listGaps({ workspace, course: courseTitle })
    const open = gaps.filter((g) => g.status === GAP_STATUS.open)
    const mastered = gaps.filter((g) => g.status === GAP_STATUS.mastered)
    const byKind = {}
    for (const gap of open) byKind[gap.kind] = (byKind[gap.kind] ?? 0) + 1
    return {
      course: courseTitle,
      total: gaps.length,
      open: open.length,
      mastered: mastered.length,
      byKind,
      gaps: open.map((g) => ({
        id: g.id,
        questionId: g.questionId,
        topic: g.topic,
        kind: g.kind,
        evidence: g.evidence,
        dueAt: g.dueAt,
      })),
    }
  }

  /** Load a course into the session state, persist it, and return it. */
  async loadCourse(agent, path) {
    const course = await readCourse(this.ctx, path)
    this.sessions.set(this.sessionKey(agent), { course, coursePath: path })
    await this.persistCourse(agent, course, path)
    return course
  }

  /**
   * Import a course from model-emitted standard markdown (the LLM-based parse
   * path: the model reads the source file and converts it into structured
   * questions). Persists to the SQLite store and turns teacher mode on.
   */
  async importCurriculum(agent, { courseTitle, markdown, sourcePath }) {
    const course = parseCurriculum(markdown)
    if (course.questions.length === 0) {
      throw new Error(
        'import_curriculum: no questions found in the converted markdown. Make sure each question is a "## Q<n>: <prompt>" heading with a prompt, and answers are "<!-- answer: ... -->" comments. Read the source file again and retry.',
      )
    }
    for (const q of course.questions) {
      if (!q.prompt || !q.prompt.trim()) {
        throw new Error(`import_curriculum: question "${q.id}" has an empty prompt — fix and retry.`)
      }
    }
    course.title = courseTitle || course.title || 'Imported course'
    this.sessions.set(this.sessionKey(agent), {
      course,
      coursePath: sourcePath ?? 'llm-import',
    })
    await this.persistCourse(agent, course, sourcePath ?? 'llm-import')
    this.set(agent, true)
    return course
  }

  /** Store one quiz run (submitted by the LLM-free quiz popup). */
  async startQuizRun(agent, answers) {
    const state = this.stateOf(agent)
    if (state === null || state.course === null) throw new Error('no course loaded (run /teach <path.md>)')
    const store = await this.storeHandle()
    const latest = store.store.latestCourse(this.workspaceOf(agent))
    if (latest === null) throw new Error('no persisted course for this workspace')
    const { runId } = store.store.createQuizRun({
      workspace: this.workspaceOf(agent),
      courseId: latest.courseId,
      answers: answers.map((a) => ({ qid: String(a.qid), answer: String(a.answer ?? '') })),
    })
    return { runId }
  }

  /** Pull a quiz run (questions with answer keys + the user's answers) for LLM analysis. */
  async quizRunForAnalysis(agent, runId) {
    const store = await this.storeHandle()
    const run = store.store.getQuizRun(runId)
    if (run === null) throw new Error(`quiz run ${runId} not found`)
    return {
      runId: run.runId,
      status: run.status,
      courseTitle: run.course?.title ?? 'untitled',
      questions: (run.course?.questions ?? []).map((q) => ({
        id: q.id,
        prompt: q.prompt,
        ...(Array.isArray(q.options) && q.options.length > 0 ? { options: q.options } : {}),
        ...(q.answer != null ? { answerKey: q.answer } : {}),
        ...(Array.isArray(q.hints) && q.hints.length > 0 ? { hints: q.hints } : {}),
      })),
      answers: run.answers,
    }
  }

  /** Mark a quiz run analyzed and log the status change (projection badge). */
  async markQuizRunAnalyzed(agent, runId, analysis) {
    const store = await this.storeHandle()
    store.store.markQuizRunAnalyzed(runId, analysis)
    try {
      agent.session.append(QUIZ_RUN_EVENT, { runId: Number(runId), status: 'analyzed' })
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-teacher: failed to append teacher/quiz-run: ${error}`)
    }
    return { runId: Number(runId), status: 'analyzed' }
  }

  /** Persist one gap: session event + durable ledger row (with FSRS card fields). */
  async recordGap(agent, input) {
    const state = this.stateOf(agent)
    if (state === null) throw new Error('no course loaded')
    const workspace = this.workspaceOf(agent)
    const courseTitle = state.course.title ?? 'untitled'
    const ledger = await this.ledgerHandle()
    const existing = ledger.store.gapsForQuestion(workspace, courseTitle, input.questionId)
    const now = nowMs()
    const gap = {
      id: gapId(workspace, courseTitle, input.questionId, existing.length + 1),
      workspace,
      course: courseTitle,
      ...buildGap(input),
      status: GAP_STATUS.open,
      intervalDays: DEFAULT_FIRST_INTERVAL_DAYS,
      ease: 2.5,
      stability: 1,
      difficulty: 5,
      createdAt: now,
      dueAt: now + DEFAULT_FIRST_INTERVAL_DAYS * 86_400_000,
      lastReviewed: null,
    }
    ledger.store.addGap(gap)
    agent.session.append('teacher/gap', { gap })
    return gap
  }

  /** Grade a question's open gaps with FSRS; mark mastered on correct. */
  async gradeQuestion(agent, { questionId, verdict }) {
    const state = this.stateOf(agent)
    if (state === null) throw new Error('no course loaded')
    const workspace = this.workspaceOf(agent)
    const courseTitle = state.course.title ?? 'untitled'
    const ledger = await this.ledgerHandle()
    const gaps = ledger.store.gapsForQuestion(workspace, courseTitle, questionId)
    const now = nowMs()
    const rating = ratingForVerdict(verdict)
    const updated = []
    for (const gap of gaps) {
      if (gap.status !== GAP_STATUS.open) continue
      if (isCorrect(verdict)) {
        ledger.store.updateGap(gap.id, {
          status: GAP_STATUS.mastered,
          lastReviewed: now,
          dueAt: null,
        })
        updated.push({ id: gap.id, status: GAP_STATUS.mastered })
        continue
      }
      const card = {
        ...createCard(now),
        state: 2, // Review
        stability: gap.stability ?? 1,
        difficulty: gap.difficulty ?? 5,
        lastReview: gap.lastReviewed ?? gap.createdAt,
      }
      const next = review(this.fsrs, card, rating, now).card
      ledger.store.updateGap(gap.id, {
        stability: next.stability,
        difficulty: next.difficulty,
        intervalDays: next.scheduledDays,
        dueAt: next.due,
        lastReviewed: now,
        status: GAP_STATUS.open,
      })
      updated.push({
        id: gap.id,
        status: GAP_STATUS.open,
        nextDueInDays: next.scheduledDays,
      })
    }
    agent.session.append('teacher/grade', { questionId, verdict, rating, updated })
    return { verdict, correct: isCorrect(verdict), updated }
  }
}

function requireTeacherMode(agent) {
  const folded = foldTeacherState(agent.session.events)
  if (!folded.active) {
    throw new Error('teacher mode is off (run /teach on or /teach <path.md>)')
  }
  return folded
}

export async function apply(ctx) {
  const controller = new TeacherController(ctx)

  // Open the question store eagerly so courseOf() can restore a persisted
  // course synchronously on the first tool use after a restart.
  void controller.storeHandle().catch(() => {})

  // Apply any queued teacher-mode selection before the next request assembly.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    controller.flushPending(agent)
    return next()
  })

  // Session projection: fold teacher/gap + teacher/grade events so the Web
  // client renders the in-session gap ledger via useProjection('teacherGaps').
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(
      gapProjectionWith(
        z.object({
          gaps: z.array(z.any()),
          grades: z.array(z.any()),
        }),
      ),
    )
    // teacherQuiz: public questions + quiz state for the LLM-free popup.
    projectionCtx.sessionProjections.register(
      quizProjectionWith(
        z.object({
          course: z.any(),
          quizActive: z.boolean(),
          lastRun: z.any(),
        }),
      ),
    )
  })

  // Quiz-submit route for the LLM-free popup: accepts answers, stores a quiz
  // run in the SQLite store, returns the run id. It never serves answer keys.
  // Lazy webServer access keeps headless profiles working (no web server).
  const webServer = ctx.get('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    webServer.register({
      kind: 'exact',
      path: '/dsh-teacher/quiz/submit',
      handler: async (req, res) => {
        let body = ''
        for await (const chunk of req) body += chunk
        let payload = null
        try {
          payload = JSON.parse(body)
        } catch {
          /* malformed body → 400 below */
        }
        const answers = Array.isArray(payload?.answers)
          ? payload.answers.filter((a) => a !== null && typeof a === 'object' && typeof a.qid === 'string' && typeof a.answer === 'string')
          : []
        const courseId = Number(payload?.courseId)
        const respond = (status, value) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(value))
        }
        if (!Number.isInteger(courseId) || answers.length === 0) {
          respond(400, { ok: false, error: 'courseId and a non-empty answers[] are required' })
          return
        }
        try {
          const store = await controller.storeHandle()
          const course = store.store.courseById(courseId)
          if (course === null) {
            respond(404, { ok: false, error: `course ${courseId} not found` })
            return
          }
          const { runId } = store.store.createQuizRun({
            workspace: course.workspace,
            courseId,
            answers: answers.map((a) => ({ qid: String(a.qid), answer: String(a.answer ?? '') })),
          })
          respond(200, { ok: true, runId })
        } catch (error) {
          respond(500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
  }

  // Conditional Socratic policy section — empty unless teacher mode is active.
  ctx.systemPrompt.section({
    name: 'teacher:policy',
    order: 50,
    text: (context) => {
      if (context.agent === undefined) return ''
      const folded = foldTeacherState(context.agent.session.events)
      if (!folded.active) return ''
      const course = controller.courseOf(context.agent)
      return buildPolicy({
        course: course ?? { title: folded.course, questions: [] },
        quiz: folded.quiz,
        quizRun: folded.lastRun,
      })
    },
  })

  // ---- slash commands -------------------------------------------------------
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'teach',
      description: 'Enter or leave teacher mode, or load a question file',
      input: { hint: '[on|off|<path-to-questions.md>]' },
      handler: async ({ agent, rawInput }) => {
        const action = rawInput.trim()
        if (action === '') {
          const folded = foldTeacherState(agent.session.events)
          const course = controller.courseOf(agent)
          return {
            kind: 'success',
            text: folded.active
              ? `Teacher mode is on. Course: ${course?.title ?? folded.course ?? '—'} (${course?.questions.length ?? 0} questions).`
              : 'Teacher mode is off. Start with /teach <path-to-questions.md>.',
          }
        }
        if (action === 'off') {
          const outcome = controller.set(agent, false)
          return {
            kind: 'success',
            text: outcome === 'committed'
              ? 'Teacher mode off.'
              : 'Leaving teacher mode (applies from the next step).',
          }
        }
        if (action === 'on') {
          const course = controller.courseOf(agent)
          if (course === null) {
            return {
              kind: 'success',
              text: 'No course loaded yet. Run /teach <path-to-questions.md> first.',
            }
          }
          const outcome = controller.set(agent, true)
          return {
            kind: 'success',
            text: outcome === 'committed'
              ? `Teacher mode on. Course: ${course.title ?? 'untitled'} (${course.questions.length} questions).`
              : 'Entering teacher mode (applies from the next step).',
          }
        }
        // /teach <path>
        try {
          const course = await controller.loadCourse(agent, action)
          if (course.questions.length === 0) {
            return {
              kind: 'success',
              text: [
                `No questions could be extracted from "${action}".`,
                'Convert it with import_curriculum: read the file with the read tool, extract each question and its correct answer, and call import_curriculum with the questions in the standard format (## Q1: <prompt> per question + <!-- answer: ... -->).',
              ].join(' '),
            }
          }
          controller.set(agent, true)
          return {
            kind: 'success',
            text: `Course loaded: ${course.title ?? 'untitled'} — ${course.questions.length} questions. Teacher mode on. Say "start" to begin the Socratic walk, "quiz me" for a quick test over the whole bank, or ask about a specific topic.`,
          }
        } catch (error) {
          return {
            kind: 'error',
            text: `Failed to load course from "${action}": ${error.message}`,
          }
        }
      },
    })

    commandCtx.commands.register({
      name: 'gaps',
      description: 'List the knowledge-gap ledger for this course',
      input: { hint: '' },
      handler: async ({ agent }) => {
        const course = controller.courseOf(agent)
        if (course === null) {
          return { kind: 'success', text: 'No course loaded. Run /teach <path-to-questions.md> first.' }
        }
        const workspace = controller.workspaceOf(agent)
        const courseTitle = course.title ?? 'untitled'
        const ledger = await controller.ledgerHandle()
        const gaps = ledger.store.listGaps({ workspace, course: courseTitle })
        if (gaps.length === 0) {
          return { kind: 'success', text: 'No gaps recorded for this course yet.' }
        }
        const open = gaps.filter((g) => g.status === GAP_STATUS.open)
        const mastered = gaps.filter((g) => g.status === GAP_STATUS.mastered)
        const lines = [
          `Gap ledger for "${courseTitle}": ${open.length} open, ${mastered.length} mastered, ${gaps.length} total.`,
          '',
          ...open.map((g) => {
            const due = g.dueAt <= Date.now() ? 'DUE' : `due in ${Math.max(1, Math.round((g.dueAt - Date.now()) / 86_400_000))}d`
            return `- [${g.kind}] ${g.topic} (${g.questionId}) — ${due} — "${g.evidence.slice(0, 80)}"`
          }),
        ]
        return { kind: 'success', text: lines.join('\n') }
      },
    })

    commandCtx.commands.register({
      name: 'retest',
      description: 'Surface due gaps for an on-demand retest drill',
      input: { hint: '' },
      handler: async ({ agent }) => {
        const course = controller.courseOf(agent)
        if (course === null) {
          return { kind: 'success', text: 'No course loaded. Run /teach <path-to-questions.md> first.' }
        }
        const workspace = controller.workspaceOf(agent)
        const courseTitle = course.title ?? 'untitled'
        const ledger = await controller.ledgerHandle()
        const due = ledger.store.dueGaps({ workspace, course: courseTitle })
        if (due.length === 0) {
          return {
            kind: 'success',
            text: 'Nothing due right now. Run /gaps to see the whole ledger.',
          }
        }
        return {
          kind: 'success',
          text: [
            `${due.length} gap(s) due — drill them now (one at a time, Socratic rules apply):`,
            '',
            ...due.map((g) => `- ${g.topic} (${g.questionId}) — last wrong: "${g.evidence.slice(0, 80)}"`),
            '',
            'Use the retest tool to pull these, then grade_answer after each.',
          ].join('\n'),
        }
      },
    })

    commandCtx.commands.register({
      name: 'quiz',
      description: 'Start a quick test over the whole question bank; the Socratic walk then focuses on the wrong questions',
      input: { hint: '' },
      handler: async ({ agent }) => {
        const course = controller.courseOf(agent)
        if (course === null) {
          return { kind: 'success', text: 'No course loaded. Run /teach <path-to-questions.md> first.' }
        }
        controller.setQuiz(agent, true)
        return {
          kind: 'success',
          text: `Quiz mode on — the quiz panel is now open: answer all ${course.questions.length} questions there (no AI involved). When you finish, the teacher will analyze your results and walk you through the misses.`,
        }
      },
    })

    commandCtx.commands.register({
      name: 'summary',
      description: 'Show the end-of-session knowledge-gap and misconception summary',
      input: { hint: '' },
      handler: async ({ agent }) => {
        const course = controller.courseOf(agent)
        if (course === null) {
          return { kind: 'success', text: 'No course loaded. Run /teach <path-to-questions.md> first.' }
        }
        const summary = await controller.summary(agent)
        if (summary.total === 0) {
          return { kind: 'success', text: 'No gaps recorded yet — nothing to summarize.' }
        }
        const kindLabel = { wrong: '错误', vague: '含糊', missing: '未答', exposed: '已提示' }
        const lines = [
          `知识缺口总结 — 《${summary.course}》`,
          `缺口 ${summary.open} 个（已掌握 ${summary.mastered} 个）`,
          summary.open > 0
            ? `按类型：${Object.entries(summary.byKind).map(([k, n]) => `${kindLabel[k] ?? k} ${n}`).join(' · ')}`
            : '全部掌握，暂无缺口。',
          '',
          ...summary.gaps.map((g) => `- [${kindLabel[g.kind] ?? g.kind}] ${g.topic} (${g.questionId}) — "${g.evidence.slice(0, 80)}"`),
          '',
          '老师可用 summary 工具生成完整报告。',
        ]
        return { kind: 'success', text: lines.join('\n') }
      },
    })
  })

  // ---- model-facing tools (always registered; gated on teacher mode) --------
  ctx.tools.register(defineTool({
    name: 'next_question',
    description:
      'Use only in teacher mode. Return one question (without its answer) by index, so the Socratic walk can proceed one question at a time. The answer key is never returned. Hints are generated by you, not taken from the file.',
    parameters: {
      index: { type: 'number', description: '0-based question index. Default 0.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
          options: { type: 'array', items: { type: 'string' } },
          total: { type: 'number', required: true },
        },
      },
      render: (args, result) => [{ type: 'text', text: `Question ${result.id}: ${result.prompt}` }],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('next_question requires a calling agent')
      requireTeacherMode(agent)
      const course = controller.courseOf(agent)
      if (course === null) throw new Error('no course loaded (run /teach <path.md>)')
      const index = Math.max(0, Math.min(Number(args.index ?? 0) | 0, course.questions.length - 1))
      const q = course.questions[index]
      return {
        id: q.id,
        prompt: q.prompt,
        ...(Array.isArray(q.options) && q.options.length > 0 ? { options: q.options } : {}),
        total: course.questions.length,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Question ${(args.index ?? 0) + 1}`,
      kind: 'other',
    }),
    presentResult: (_args, result) => {
      if (result.isError) return void 0
      const v = result.value
      return {
        card: 'generic',
        title: `Question ${v.id}`,
        content: `${v.prompt}\n\n(${v.total} questions in this course)`,
        options: v.options,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'import_curriculum',
    description:
      'Load a course from a markdown question file in any format. Read the raw file with the read tool first, then extract EVERY question with its prompt and its correct answer — from markers like "→ **Answer:**", "Answer:", "答案：", ✅/bold multiple-choice options, or from your own knowledge (omit the answer if you are not confident; never invent one). Emit the questions in the standard format and pass them as the markdown argument: one "## Q1: <prompt>" heading per question, the answer as "<!-- answer: ... -->", and optional choices as "<!-- options: A. x | B. y | C. z | D. w -->". Preserve the original numbering. This replaces the currently loaded course and turns teacher mode on, but does NOT start teaching: introduce the course briefly and wait for the user to ask (e.g. "start" or "quiz me").',
    parameters: {
      courseTitle: { type: 'string', required: true, description: 'Short course title, e.g. "English Wrong Answers".' },
      markdown: { type: 'string', required: true, description: 'The converted questions in standard format.' },
      sourcePath: { type: 'string', description: 'Original file path, when known.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', const: true, required: true },
          title: { type: 'string' },
          questionCount: { type: 'number', required: true },
          firstQuestionId: { type: 'string' },
          firstPrompt: { type: 'string' },
        },
      },
      render: (_args, result) => [
        { type: 'text', text: `Course imported: ${result.title} — ${result.questionCount} questions. Say "start" to begin, or "quiz me" for a quick test.` },
      ],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('import_curriculum requires a calling agent')
      const course = await controller.importCurriculum(agent, {
        courseTitle: args.courseTitle,
        markdown: args.markdown,
        sourcePath: args.sourcePath,
      })
      const first = course.questions[0]
      return {
        ok: true,
        title: course.title,
        questionCount: course.questions.length,
        firstQuestionId: first.id,
        firstPrompt: first.prompt,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Import curriculum', kind: 'other' }),
    presentResult: (_args, result) => {
      if (result.isError) return void 0
      const v = result.value
      return {
        card: 'generic',
        title: 'Course imported',
        content: `${v.title} — ${v.questionCount} questions. Say "start" to begin, or "quiz me" for a quick test.`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'note_gap',
    description:
      'Use only in teacher mode. Record a knowledge gap detected in the user\'s answer (wrong / vague / missing / exposed). Include the user\'s verbatim quote. Never narrate that you are recording it.',
    parameters: {
      questionId: { type: 'string', required: true },
      topic: { type: 'string', required: true, description: 'The missing/weak concept, e.g. "TCP handshake failure modes".' },
      userQuote: { type: 'string', required: true, description: 'The user\'s exact words (or a faithful paraphrase).' },
      kind: {
        type: 'string', required: true,
        enum: ['wrong', 'vague', 'missing', 'exposed'],
        description: 'wrong: factual error; vague: imprecise; missing: no answer / "I don\'t know"; exposed: the answer was revealed because the user gave up.',
      },
      confidence: { type: 'number', description: 'User-stated confidence 1..5, when available.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', const: true, required: true },
        },
      },
      render: () => [{ type: 'text', text: 'Gap recorded.' }],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('note_gap requires a calling agent')
      requireTeacherMode(agent)
      const gap = await controller.recordGap(agent, args)
      return { ok: true, gapId: gap.id }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Gap: ${args.topic}`,
      kind: 'other',
    }),
    presentResult: (_args, result) => {
      if (result.isError) return void 0
      const v = result.value
      return {
        card: 'generic',
        title: 'Gap recorded',
        content: `recorded ${v.gapId}`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grade_answer',
    description:
      'Use only in teacher mode. Grade the user\'s answer to a question against its hidden answer key: verdict correct | partial | wrong | no-answer. Updates the FSRS schedule for every open gap of that question; correct marks them mastered.',
    parameters: {
      questionId: { type: 'string', required: true },
      userAnswer: { type: 'string', required: true, description: 'The user\'s answer (verbatim).' },
      verdict: {
        type: 'string', required: true,
        enum: ['correct', 'partial', 'wrong', 'no-answer'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdict: { type: 'string', required: true },
          correct: { type: 'boolean', required: true },
          updated: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { id: { type: 'string' }, status: { type: 'string' } },
            },
            required: true,
          },
        },
      },
      render: (args, result) => [
        { type: 'text', text: `Verdict: ${verdictLabel(result.verdict)} (${result.correct ? 'resolved' : 'gap updated'}).` },
      ],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('grade_answer requires a calling agent')
      requireTeacherMode(agent)
      return controller.gradeQuestion(agent, args)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Grade ${args.questionId}`,
      kind: 'other',
    }),
    presentResult: (_args, result) => {
      if (result.isError) return void 0
      const v = result.value
      return {
        card: 'generic',
        title: 'Grade',
        content: `Verdict: ${verdictLabel(v.verdict)} — ${v.correct ? 'resolved' : 'gap updated'}`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'retest',
    description:
      'Use only in teacher mode. Return the gaps currently due for this course (FSRS schedule). Drill them one at a time with Socratic questioning; after each, call grade_answer.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          due: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                questionId: { type: 'string' },
                topic: { type: 'string' },
                evidence: { type: 'string' },
                kind: { type: 'string' },
              },
            },
            required: true,
          },
        },
      },
      render: (_args, result) => [
        { type: 'text', text: result.due.length ? `${result.due.length} gap(s) due.` : 'Nothing due right now.' },
      ],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('retest requires a calling agent')
      requireTeacherMode(agent)
      const course = controller.courseOf(agent)
      if (course === null) throw new Error('no course loaded (run /teach <path.md>)')
      const workspace = controller.workspaceOf(agent)
      const courseTitle = course.title ?? 'untitled'
      const ledger = await controller.ledgerHandle()
      const due = ledger.store.dueGaps({ workspace, course: courseTitle })
      return {
        due: due.map((g) => ({
          id: g.id,
          questionId: g.questionId,
          topic: g.topic,
          evidence: g.evidence,
          kind: g.kind,
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Retest', kind: 'other' }),
    presentResult: (_args, result) => {
      if (result.isError) return void 0
      const v = result.value
      return {
        card: 'generic',
        title: 'Retest',
        content: v.due.length
          ? `${v.due.length} gap(s) due — drill them one at a time.`
          : 'Nothing due right now.',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'quiz',
    description:
      'Use only in teacher mode. Quick-test mode over the whole question bank. Without "done": turns quiz mode on and returns EVERY question (id, prompt, options, section — never the answers) so you can ask them all quickly. After the test, grade each with grade_answer and note_gap the non-correct ones. Then call quiz with done: true: it ends quiz mode and returns the wrong questions (from the recorded gaps) so the Socratic walk focuses only on those.',
    parameters: {
      done: { type: 'boolean', description: 'true ends quiz mode and returns the wrong-question focus list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                prompt: { type: 'string' },
                options: { type: 'array', items: { type: 'string' } },
                section: { type: 'string' },
              },
            },
          },
          focus: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                questionId: { type: 'string' },
                gaps: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string' },
                      topic: { type: 'string' },
                      kind: { type: 'string' },
                      evidence: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        // DSL note: requiredness is per-property ("required: true"), never a
        // root-level "required: [...]" array — the DSL rejects that at mount.
      },
      render: (_args, result) => [
        { type: 'text', text: result.mode === 'quiz'
          ? `Quiz mode on — ${result.questions.length} questions.`
          : `Quiz done — ${result.focus.length} question(s) to walk: ${result.focus.map((f) => f.questionId).join(', ') || 'none'}.` },
      ],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('quiz requires a calling agent')
      requireTeacherMode(agent)
      const course = controller.courseOf(agent)
      if (course === null) throw new Error('no course loaded (run /teach <path.md>)')
      if (args.done) {
        controller.setQuiz(agent, false)
        const wrong = await controller.wrongQuestions(agent)
        return { mode: 'walk', focus: wrong.questions, questions: [] }
      }
      controller.setQuiz(agent, true)
      // Map to the output schema exactly (additionalProperties: false): keep
      // only id/prompt/options/section, omit absent keys (lossless JSON).
      const questions = publicQuestions(course).map((q) => ({
        id: q.id,
        prompt: q.prompt,
        ...(Array.isArray(q.options) && q.options.length > 0 ? { options: q.options } : {}),
        ...(q.section ? { section: q.section } : {}),
      }))
      return { mode: 'quiz', questions, focus: [] }
    },
    presentCall: () => ({ card: 'generic', title: 'Quiz', kind: 'other' }),
    presentResult: (_args, result) => {
      if (result.isError) return void 0
      const v = result.value
      return {
        card: 'generic',
        title: v.mode === 'quiz' ? 'Quiz mode on' : 'Quiz done',
        content: v.mode === 'quiz'
          ? `${v.questions.length} questions — ask them all, then call quiz with done: true.`
          : `${v.focus.length} wrong question(s) to walk: ${v.focus.map((f) => f.questionId).join(', ') || 'none'}.`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'analyze_quiz',
    description:
      'Use only in teacher mode. Analyze a finished quiz run submitted through the LLM-free quiz popup. Without "done": returns the run\'s questions (with hidden answer keys and hints), the user\'s answers, and the course title. Grade each answer against its answer key (correct | partial | wrong | no-answer), call grade_answer per question and note_gap for non-correct ones, then run the Socratic walk only on the misses. After the walk is complete, call analyze_quiz again with done: true to mark the run analyzed.',
    parameters: {
      runId: { type: 'number', required: true, description: 'The quiz run id (from the user\'s "Quiz finished (run <id>)" message).' },
      done: { type: 'boolean', description: 'true marks the run analyzed after the walk is complete.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'number', required: true },
          status: { type: 'string' },
          courseTitle: { type: 'string' },
          questionCount: { type: 'number' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                prompt: { type: 'string' },
                options: { type: 'array', items: { type: 'string' } },
                answerKey: { type: 'string' },
                hints: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          answers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                qid: { type: 'string' },
                answer: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, result) => {
        if (result.status === 'analyzed') {
          return [{ type: 'text', text: `Quiz run ${result.runId} marked analyzed.` }]
        }
        return [{
          type: 'text',
          text: `Quiz run ${result.runId} — ${result.courseTitle}: ${result.questionCount} question(s), ${result.answers.length} answer(s). Grade them, then walk the misses.`,
        }]
      },
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('analyze_quiz requires a calling agent')
      requireTeacherMode(agent)
      if (args.done) {
        return controller.markQuizRunAnalyzed(agent, args.runId, null)
      }
      const run = await controller.quizRunForAnalysis(agent, args.runId)
      return {
        runId: run.runId,
        status: run.status,
        courseTitle: run.courseTitle,
        questionCount: run.questions.length,
        questions: run.questions,
        answers: run.answers,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Analyze quiz run ${args.runId}`,
      kind: 'other',
    }),
    presentResult: (_args, result) => {
      if (result.isError) return void 0
      const v = result.value
      return {
        card: 'generic',
        title: v.status === 'analyzed' ? 'Quiz analyzed' : 'Quiz run loaded',
        content: v.status === 'analyzed'
          ? `Run ${v.runId} marked analyzed.`
          : `${v.courseTitle} — ${v.questionCount} questions, ${v.answers.length} answers.`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'summary',
    description:
      'Use only in teacher mode. Pull the gap ledger for the current course and produce the end-of-session knowledge-point summary: open gaps (topic, kind, the user\'s own words), counts by kind, and mastered count. Call this when the lesson ends or the user asks for a summary.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          course: { type: 'string', required: true },
          total: { type: 'number', required: true },
          open: { type: 'number', required: true },
          mastered: { type: 'number', required: true },
          byKind: { type: 'object', additionalProperties: false, properties: { wrong: { type: 'number' }, vague: { type: 'number' }, missing: { type: 'number' }, exposed: { type: 'number' } } },
          gaps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                questionId: { type: 'string' },
                topic: { type: 'string' },
                kind: { type: 'string' },
                evidence: { type: 'string' },
                dueAt: { type: 'number' },
              },
            },
            required: true,
          },
        },
        // DSL note: requiredness is per-property ("required: true"), never a
        // root-level "required: [...]" array — the DSL rejects that at mount.
      },
      render: (_args, result) => [
        { type: 'text', text: `Summary: ${result.open} open gaps, ${result.mastered} mastered (of ${result.total}).` },
      ],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('summary requires a calling agent')
      requireTeacherMode(agent)
      return controller.summary(agent)
    },
    presentCall: () => ({ card: 'generic', title: 'Summary', kind: 'other' }),
    presentResult: (_args, result) => {
      if (result.isError) return void 0
      const v = result.value
      return {
        card: 'generic',
        title: 'Gap summary',
        content: `${v.open} open gaps, ${v.mastered} mastered (${v.total} total). ${v.gaps.length} gap(s) to review.`,
      }
    },
  }))
}

export { TeacherController }
