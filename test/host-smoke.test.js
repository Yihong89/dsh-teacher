/**
 * Host-plugin smoke test: mounts index.js against mocked DSH services and
 * asserts the prompt section, commands, and tools register; then exercises the
 * /teach command against the real sample curriculum file.
 *
 * index.js imports '@deepseek-ai/dsh-tools' (defineTool), which is normally
 * resolved from the DSH install. For this standalone test we materialize a
 * gitignored stub at node_modules/@deepseek-ai/dsh-tools so the bare import
 * resolves; defineTool is identity in the stub.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function installToolStub() {
  const dir = join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-tools', type: 'module', main: 'index.js' }),
  )
  writeFileSync(
    join(dir, 'index.js'),
    'export function defineTool(def) { return def }\n',
  )
  // zod stub — index.js builds the projection schema with z.object; the
  // registry mock never validates, so a permissive shape is enough.
  const zodDir = join(REPO_ROOT, 'node_modules', 'zod')
  mkdirSync(zodDir, { recursive: true })
  writeFileSync(
    join(zodDir, 'package.json'),
    JSON.stringify({ name: 'zod', type: 'module', main: 'index.js' }),
  )
  writeFileSync(
    join(zodDir, 'index.js'),
    'export const z = { object: (s) => ({ _shape: s }), array: (x) => x, any: () => "any" }\n',
  )
  return dir
}

function mockSession() {
  const session = {
    id: 's1',
    meta: { cwd: '/tmp' },
    events: [],
    append(type, data) {
      this.events.push({ type, data })
    },
  }
  return session
}

function mockCtx() {
  const registrations = { sections: [], commands: [], tools: [], events: {}, projections: [] }
  const ctx = {
    get: () => undefined,
    on(name, fn) {
      ;(registrations.events[name] ??= []).push(fn)
    },
    inject(_deps, fn) {
      fn(ctx)
    },
    systemPrompt: {
      section: (s) => registrations.sections.push(s),
    },
    tools: {
      register: (t) => registrations.tools.push(t),
    },
    commands: {
      register: (c) => registrations.commands.push(c),
    },
    sessionProjections: {
      register: (def) => registrations.projections.push(def),
    },
    logger: { warn: () => {} },
  }
  return { ctx, registrations }
}

let stubDir = null
let smokeLedgerDir = null

before(() => {
  stubDir = installToolStub()
  // Redirect the durable ledger to a throwaway file so smoke tests never
  // touch the real $DSH_HOME/state ledger.
  smokeLedgerDir = mkdtempSync(join(tmpdir(), 'dsh-teacher-smoke-'))
  process.env.DSH_TEACHER_LEDGER = join(smokeLedgerDir, 'ledger.db')
})

test('host plugin registers section, commands, tools, and the gap projection', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)

  assert.equal(registrations.sections.length, 1)
  assert.equal(registrations.sections[0].name, 'teacher:policy')

  assert.deepEqual(
    registrations.commands.map((c) => c.name).sort(),
    ['gaps', 'quiz', 'retest', 'summary', 'teach'],
  )
  assert.deepEqual(
    registrations.tools.map((t) => t.name).sort(),
    ['grade_answer', 'import_curriculum', 'next_question', 'note_gap', 'quiz', 'retest', 'summary'],
  )
  assert.ok(registrations.events['agent/pre-step'])
  assert.equal(registrations.projections.length, 1)
  assert.equal(registrations.projections[0].key, 'teacherGaps')
  assert.equal(registrations.projections[0].stateVersion, 1)

  // Regression guard: the dsh-tools value-schema DSL rejects a root-level
  // "required: [...]" array at mount (requiredness must be per-property).
  // This exact bug broke the teacher preset twice; keep it pinned.
  for (const tool of registrations.tools) {
    assert.ok(
      !Object.hasOwn(tool.output.schema, 'required'),
      `tool "${tool.name}" output.schema must not declare a root-level "required" array`,
    )
    assert.ok(
      !Object.hasOwn(tool.parameters, 'required'),
      `tool "${tool.name}" parameters must not declare a root-level "required" array`,
    )
  }
})

test('teacher:policy section is empty until mode is active, then renders policy', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)
  const section = registrations.sections[0]

  const agent = { session: mockSession() }
  assert.equal(section.text({ agent }), '')

  agent.session.append('teacher/mode', { active: true, course: null })
  const text = section.text({ agent })
  assert.ok(text.includes('教师模式'))
  assert.ok(text.includes('永不直接给出答案'))
  assert.ok(text.includes('知识缺口回退'))
  assert.ok(text.includes('不要立即开始提问'))
  assert.ok(text.includes('这道题还有什么疑问吗'))
  assert.ok(text.includes('调用 summary 工具'))
  assert.ok(!text.includes('快速测试模式'))

  // quiz mode appends the quick-test block
  agent.session.append('teacher/quiz', { active: true })
  const quizText = section.text({ agent })
  assert.ok(quizText.includes('快速测试模式'))
  assert.ok(quizText.includes('quiz（done: true）'))
})

test('/teach <path> loads the sample course and enters teacher mode', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)
  const teach = registrations.commands.find((c) => c.name === 'teach')

  const agent = { session: mockSession() }
  const sample = join(REPO_ROOT, 'docs', 'questions.example.md')
  const result = await teach.handler({ agent, rawInput: sample })

  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('Course loaded: Networking review'))
  assert.ok(result.text.includes('3 questions'))
  // mode event appended to the session
  const mode = agent.session.events.find((e) => e.type === 'teacher/mode')
  assert.ok(mode && mode.data.active === true)
  assert.equal(mode.data.course, 'Networking review')
})

test('/teach off and empty state reporting', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)
  const teach = registrations.commands.find((c) => c.name === 'teach')

  const agent = { session: mockSession() }
  const status = await teach.handler({ agent, rawInput: '' })
  assert.ok(status.text.includes('Teacher mode is off'))

  const off = await teach.handler({ agent, rawInput: 'off' })
  assert.equal(off.kind, 'success')

  const on = await teach.handler({ agent, rawInput: 'on' })
  assert.ok(on.text.includes('No course loaded'))
})

test('import_curriculum loads a converted course and enters teacher mode', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)
  const imp = registrations.tools.find((t) => t.name === 'import_curriculum')

  const agent = { session: mockSession() }
  const result = await imp.execute({
    courseTitle: 'My Deck',
    sourcePath: 'notes.md',
    markdown: [
      '## Q1: What is TCP?',
      '<!-- answer: a reliable connection-oriented protocol -->',
      '## Q2: Choose one.',
      '<!-- options: A. x | B. y -->',
      '<!-- answer: B -->',
    ].join('\n'),
  }, { agent })

  assert.equal(result.ok, true)
  assert.equal(result.questionCount, 2)
  assert.equal(result.title, 'My Deck')
  const mode = agent.session.events.find((e) => e.type === 'teacher/mode')
  assert.ok(mode && mode.data.active === true)
  assert.equal(mode.data.course, 'My Deck')
})

test('import_curriculum rejects a conversion with no questions', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)
  const imp = registrations.tools.find((t) => t.name === 'import_curriculum')
  const agent = { session: mockSession() }
  await assert.rejects(
    () => imp.execute({ courseTitle: 'Empty', markdown: '# Just prose\nno questions here' }, { agent }),
    /no questions found/,
  )
})

test('quiz: start returns the whole bank and flips quiz mode; done returns wrong questions', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)
  const imp = registrations.tools.find((t) => t.name === 'import_curriculum')
  const quiz = registrations.tools.find((t) => t.name === 'quiz')
  const note = registrations.tools.find((t) => t.name === 'note_gap')

  const agent = { session: mockSession() }
  await imp.execute({
    courseTitle: 'Deck',
    markdown: '## Q1: A?\n<!-- answer: a -->\n## Q2: B?\n<!-- answer: b -->\n',
  }, { agent })

  const started = await quiz.execute({}, { agent })
  assert.equal(started.mode, 'quiz')
  assert.equal(started.questions.length, 2)
  assert.ok(started.questions.every((q) => !('answer' in q)))
  const quizEvent = agent.session.events.find((e) => e.type === 'teacher/quiz')
  assert.ok(quizEvent && quizEvent.data.active === true)

  // user missed Q2 during the quiz → the teacher records the gap
  await note.execute({
    questionId: 'q2', topic: 'concept b', userQuote: 'i guessed', kind: 'wrong', confidence: 2,
  }, { agent })

  const done = await quiz.execute({ done: true }, { agent })
  assert.equal(done.mode, 'walk')
  assert.equal(done.focus.length, 1)
  assert.equal(done.focus[0].questionId, 'q2')
  const off = agent.session.events.filter((e) => e.type === 'teacher/quiz').at(-1)
  assert.equal(off.data.active, false)
})

test('summary: pulls the ledger for the end-of-session report', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)
  const imp = registrations.tools.find((t) => t.name === 'import_curriculum')
  const note = registrations.tools.find((t) => t.name === 'note_gap')
  const summary = registrations.tools.find((t) => t.name === 'summary')

  const agent = { session: mockSession() }
  await imp.execute({ courseTitle: 'Summary Deck', markdown: '## Q1: A?\n<!-- answer: a -->\n' }, { agent })
  await note.execute({
    questionId: 'q1', topic: 'tcp handshake', userQuote: 'no idea', kind: 'missing', confidence: 1,
  }, { agent })

  const result = await summary.execute({}, { agent })
  assert.equal(result.course, 'Summary Deck')
  assert.equal(result.open, 1)
  assert.equal(result.mastered, 0)
  assert.equal(result.byKind.missing, 1)
  assert.equal(result.gaps[0].topic, 'tcp handshake')
  assert.equal(result.gaps[0].evidence, 'no idea')
})

test.after(() => {
  if (stubDir) rmSync(join(REPO_ROOT, 'node_modules'), { recursive: true, force: true })
  if (smokeLedgerDir) rmSync(smokeLedgerDir, { recursive: true, force: true })
  delete process.env.DSH_TEACHER_LEDGER
})
