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
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { parseCurriculum, publicQuestions } from './lib/curriculum.js'
import { buildPolicy } from './lib/policy.js'
import { LedgerStore, gapId, GAP_STATUS } from './lib/ledger.js'
import { foldTeacherState, hasOpenTurn } from './lib/fold.js'
import {
  buildGap, gapKindForVerdict, isCorrect, ratingForVerdict, verdictLabel,
} from './lib/grading.js'
import { FSRS, createCard, review } from './lib/fsrs.js'

export const name = 'dsh-teacher'

/** Required host services: tool registry and system-prompt assembly. */
export const inject = ['tools', 'systemPrompt']

const DEFAULT_FIRST_INTERVAL_DAYS = 1

function nowMs() {
  return Date.now()
}

function ledgerFilePath() {
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
    this.sessions = new WeakMap() // Session -> { course, coursePath }
    this.pendingIntents = new WeakMap() // Session -> { active, narrate }
    this.ledger = null
    this.fsrs = new FSRS()
  }

  async ledgerHandle() {
    if (this.ledger === null) {
      this.ledger = await LedgerStore.open(ledgerFilePath())
    }
    return this.ledger
  }

  stateOf(agent) {
    return this.sessions.get(agent.session) ?? null
  }

  courseOf(agent) {
    return this.stateOf(agent)?.course ?? null
  }

  /** Workspace key used to scope the durable ledger. */
  workspaceOf(agent) {
    return agent.session.meta?.cwd ?? agent.session.id
  }

  get(agent) {
    const active = foldTeacherState(agent.session.events).active
    const pending = this.pendingIntents.get(agent.session)
    return pending === undefined ? { active } : { active, pending: pending.active }
  }

  /**
   * Select teacher mode. Between turns the change is appended immediately;
   * during an open turn it stays pending until the next accepted in-turn
   * pre-step (see #flushPending below).
   */
  set(agent, active) {
    const session = agent.session
    const pending = this.pendingIntents.get(session)
    const target = pending?.active ?? foldTeacherState(session.events).active
    if (active === target) return 'noop'
    if (hasOpenTurn(session.events)) {
      this.pendingIntents.set(session, { active })
      return foldTeacherState(session.events).active === active ? 'cancelled' : 'queued'
    }
    if (active === foldTeacherState(session.events).active) {
      this.pendingIntents.delete(session)
      return 'cancelled'
    }
    try {
      const state = this.stateOf(agent)
      session.append('teacher/mode', {
        active,
        course: state?.course?.title ?? null,
      })
      this.pendingIntents.delete(session)
      return 'committed'
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-teacher: failed to append teacher/mode: ${error}`)
      this.pendingIntents.set(session, { active })
      return 'queued'
    }
  }

  /** Apply one pending selection before the next request assembly. */
  flushPending(agent) {
    const pending = this.pendingIntents.get(agent.session)
    if (pending === undefined) return
    if (pending.active === foldTeacherState(agent.session.events).active) {
      this.pendingIntents.delete(agent.session)
      return
    }
    try {
      const state = this.stateOf(agent)
      agent.session.append('teacher/mode', {
        active: pending.active,
        course: state?.course?.title ?? null,
      })
      this.pendingIntents.delete(agent.session)
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-teacher: failed to flush teacher/mode: ${error}`)
    }
  }

  /** Load a course into the session state and return it. */
  async loadCourse(agent, path) {
    const course = await readCourse(this.ctx, path)
    this.sessions.set(agent.session, { course, coursePath: path })
    return course
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

  // Apply any queued teacher-mode selection before the next request assembly.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    controller.flushPending(agent)
    return next()
  })

  // Conditional Socratic policy section — empty unless teacher mode is active.
  ctx.systemPrompt.section({
    name: 'teacher:policy',
    order: 50,
    text: (context) => {
      if (context.agent === undefined) return ''
      const folded = foldTeacherState(context.agent.session.events)
      if (!folded.active) return ''
      const course = controller.courseOf(context.agent)
      return buildPolicy({ course: course ?? { title: folded.course, questions: [] } })
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
          controller.set(agent, true)
          return {
            kind: 'success',
            text: `Course loaded: ${course.title ?? 'untitled'} — ${course.questions.length} questions. Teacher mode on. First question: ${course.questions[0]?.id ?? '—'}.`,
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
  })

  // ---- model-facing tools (always registered; gated on teacher mode) --------
  ctx.tools.register(defineTool({
    name: 'next_question',
    description:
      'Use only in teacher mode. Return one question (without its answer) by index, so the Socratic walk can proceed one question at a time. The answer key is never returned.',
    parameters: {
      index: { type: 'number', description: '0-based question index. Default 0.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          prompt: { type: 'string' },
          hintCount: { type: 'number' },
          total: { type: 'number' },
        },
        required: ['id', 'prompt', 'total'],
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
        hintCount: q.hints.length,
        total: course.questions.length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hint',
    description:
      'Use only in teacher mode. Reveal the hint at the given 1-based level for a question (never the answer). If level is omitted, reveal the next level after the highest already used.',
    parameters: {
      questionId: { type: 'string', required: true },
      level: { type: 'number', description: '1-based hint level.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { hint: { type: 'string' }, level: { type: 'number' } },
        required: ['hint', 'level'],
      },
      render: (args, result) => [{ type: 'text', text: `Hint ${result.level}: ${result.hint}` }],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('hint requires a calling agent')
      requireTeacherMode(agent)
      const course = controller.courseOf(agent)
      if (course === null) throw new Error('no course loaded (run /teach <path.md>)')
      const q = course.questions.find((x) => x.id === args.questionId)
      if (q === undefined) throw new Error(`unknown question: ${args.questionId}`)
      if (q.hints.length === 0) throw new Error('this question has no hints')
      let level = args.level === undefined ? q.hints.length : Number(args.level) | 0
      level = Math.min(Math.max(level, 1), q.hints.length)
      return { hint: q.hints[level - 1], level }
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
        properties: { ok: { type: 'boolean', const: true } },
        required: ['ok'],
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
          verdict: { type: 'string' },
          correct: { type: 'boolean' },
          updated: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { id: { type: 'string' }, status: { type: 'string' } },
            },
          },
        },
        required: ['verdict', 'correct', 'updated'],
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
          },
        },
        required: ['due'],
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
  }))
}
