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
    'export const z = { object: (s) => ({ _shape: s }), array: (x) => x, any: () => "any", boolean: () => "boolean" }\n',
  )
  // @deepseek-ai/dsh-session stub — index.js and lib/register-events.js
  // register their session event types into the shared catalog Set.
  const sessionDir = join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh-session')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(
    join(sessionDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-session', type: 'module', main: 'index.js' }),
  )
  writeFileSync(
    join(sessionDir, 'index.js'),
    'export const KNOWN_SESSION_EVENT_TYPES = new Set()\n',
  )
  return dir
}

function mockSession(cwd = '/tmp') {
  const session = {
    id: 's1',
    meta: { cwd },
    events: [],
    append(type, data) {
      this.events.push({ type, data })
    },
  }
  return session
}

function mockCtx(opts = {}) {
  const registrations = { sections: [], commands: [], tools: [], events: {}, projections: [], webRoutes: [] }
  const webServer = opts.webServer === true
    ? {
        register: (route) => {
          registrations.webRoutes.push(route)
          return () => {}
        },
      }
    : undefined
  const ctx = {
    get: (key) => (key === 'webServer' ? webServer : undefined),
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
let smokeHomeDir = null

before(() => {
  stubDir = installToolStub()
  // Redirect the durable ledger AND the course store to throwaway locations
  // so smoke tests never touch the real $DSH_HOME/state.
  smokeLedgerDir = mkdtempSync(join(tmpdir(), 'dsh-teacher-smoke-'))
  process.env.DSH_TEACHER_LEDGER = join(smokeLedgerDir, 'ledger.db')
  smokeHomeDir = mkdtempSync(join(tmpdir(), 'dsh-teacher-home-'))
  process.env.DSH_HOME = smokeHomeDir
})

test('host plugin registers section, commands, tools, and the gap projection', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)

  assert.equal(registrations.sections.length, 1)
  assert.equal(registrations.sections[0].name, 'teacher:policy')

  assert.deepEqual(
    registrations.commands.map((c) => c.name).sort(),
    ['course', 'gaps', 'quiz', 'retest', 'summary', 'teach'],
  )
  assert.deepEqual(
    registrations.tools.map((t) => t.name).sort(),
    ['analyze_quiz', 'grade_answer', 'import_curriculum', 'next_question', 'note_gap', 'quiz', 'retest', 'summary'],
  )
  assert.ok(registrations.events['agent/pre-step'])
  assert.deepEqual(
    registrations.projections.map((p) => p.key).sort(),
    ['teacherGaps', 'teacherQuiz'],
  )
  assert.ok(registrations.projections.every((p) => p.stateVersion === 1))

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

  // quiz mode appends the popup/analysis block
  agent.session.append('teacher/quiz', { active: true })
  const quizText = section.text({ agent })
  assert.ok(quizText.includes('快速测试模式'))
  assert.ok(quizText.includes('analyze_quiz'))
  assert.ok(quizText.includes('📝'))
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

  // Unique workspace so no persisted course leaks in from earlier tests.
  const agent = { session: mockSession('/empty-workspace-no-course') }
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

test('event types are registered with the harness persistence catalog', async () => {
  const { KNOWN_SESSION_EVENT_TYPES } = await import('@deepseek-ai/dsh-session')
  // index.js registers at module load
  for (const type of ['teacher/mode', 'teacher/gap', 'teacher/grade', 'teacher/quiz', 'teacher/course', 'teacher/quiz-run']) {
    assert.ok(KNOWN_SESSION_EVENT_TYPES.has(type), `expected ${type} registered`)
  }
  // the profile-boot registrar (dsh-teacher/register-events) registers too
  const registrar = await import('../lib/register-events.js')
  assert.equal(registrar.name, 'dsh-teacher/register-events')
  registrar.apply()
  assert.ok(KNOWN_SESSION_EVENT_TYPES.has('teacher/mode'))
  assert.ok(KNOWN_SESSION_EVENT_TYPES.has('teacher/course'))
  assert.ok(KNOWN_SESSION_EVENT_TYPES.has('teacher/quiz-run'))
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
  if (smokeHomeDir) rmSync(smokeHomeDir, { recursive: true, force: true })
  delete process.env.DSH_TEACHER_LEDGER
  delete process.env.DSH_HOME
})

test('next_question output is lossless JSON (options omitted when absent)', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)
  const imp = registrations.tools.find((t) => t.name === 'import_curriculum')
  const nq = registrations.tools.find((t) => t.name === 'next_question')

  const agent = { session: mockSession('/next-q-ls-workspace') }
  await imp.execute({ courseTitle: 'LS', markdown: '## Q1: A?\n<!-- answer: a -->\n' }, { agent })
  const result = await nq.execute({ index: 0 }, { agent })

  // The returned object must round-trip through JSON losslessly: a bare
  // `options: undefined` key would be dropped and fail dsh validation.
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  assert.equal('options' in result, false)
})

test('/teach persists the course and logs public questions (no answer keys)', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)
  const teach = registrations.commands.find((c) => c.name === 'teach')

  const agent = { session: mockSession('/persist-teach') }
  const sample = join(REPO_ROOT, 'docs', 'questions.example.md')
  const result = await teach.handler({ agent, rawInput: sample })
  assert.equal(result.kind, 'success')

  const courseEvent = agent.session.events.find((e) => e.type === 'teacher/course')
  assert.ok(courseEvent, 'teacher/course event appended')
  assert.ok(courseEvent.data.courseId != null, 'courseId present for the popup submit')
  assert.equal(courseEvent.data.title, 'Networking review')
  assert.equal(courseEvent.data.questions.length, 3)
  for (const q of courseEvent.data.questions) {
    assert.equal('answer' in q, false, 'public question must not carry the answer key')
    assert.equal('answerKey' in q, false)
  }
})

test('quiz submit route stores a run; analyze_quiz grades it and marks it analyzed', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx({ webServer: true })
  await apply(ctx)
  const imp = registrations.tools.find((t) => t.name === 'import_curriculum')
  const analyze = registrations.tools.find((t) => t.name === 'analyze_quiz')
  const route = registrations.webRoutes.find((r) => r.path === '/dsh-teacher/quiz/submit')
  assert.ok(route, 'quiz submit route registered on webServer')

  const agent = { session: mockSession('/quiz-route-workspace') }
  await imp.execute({
    courseTitle: 'Deck',
    markdown: '## Q1: A?\n<!-- answer: a -->\n## Q2: Choose.\n<!-- options: A. x | B. y -->\n<!-- answer: B -->\n',
  }, { agent })

  const courseEvent = agent.session.events.find((e) => e.type === 'teacher/course')
  const courseId = courseEvent.data.courseId

  // Simulate the LLM-free popup POST.
  const req = {
    [Symbol.asyncIterator]: async function* () {
      yield JSON.stringify({
        courseId,
        answers: [{ qid: 'q1', answer: 'tcp' }, { qid: 'q2', answer: 'cat' }],
      })
    },
  }
  let resStatus = 0
  let resBody = ''
  const res = {
    writeHead: (status) => { resStatus = status },
    end: (body) => { resBody = body },
  }
  await route.handler(req, res)
  assert.equal(resStatus, 200)
  const submitted = JSON.parse(resBody)
  assert.equal(submitted.ok, true)
  assert.ok(submitted.runId != null)

  // The route rejects malformed payloads.
  const badReq = {
    [Symbol.asyncIterator]: async function* () { yield '{}' },
  }
  let badStatus = 0
  await route.handler(badReq, { writeHead: (s) => { badStatus = s }, end: () => {} })
  assert.equal(badStatus, 400)

  // analyze_quiz returns the run with answer keys (trusted teacher) + answers.
  const run = await analyze.execute({ runId: submitted.runId }, { agent })
  assert.equal(run.status, 'pending')
  assert.equal(run.questionCount, 2)
  assert.equal(run.answers[0].answer, 'tcp')
  assert.equal(run.questions[0].answerKey, 'a')
  assert.equal(run.questions[1].options.length, 2)
  assert.equal(run.courseTitle, 'Deck')

  // done marks the run analyzed and appends teacher/quiz-run.
  const done = await analyze.execute({ runId: submitted.runId, done: true }, { agent })
  assert.equal(done.status, 'analyzed')
  const runEvent = agent.session.events.filter((e) => e.type === 'teacher/quiz-run').at(-1)
  assert.deepEqual(runEvent.data, { runId: submitted.runId, status: 'analyzed' })
})

test('a course persisted to the SQLite store is restored by a fresh controller', async () => {
  const first = mockCtx()
  await (await import('../index.js')).apply(first.ctx)
  const teach = first.registrations.commands.find((c) => c.name === 'teach')
  const agent = { session: mockSession('/restore-workspace') }
  const sample = join(REPO_ROOT, 'docs', 'questions.example.md')
  await teach.handler({ agent, rawInput: sample })
  // let the eager store open + upsert settle
  await new Promise((resolve) => setTimeout(resolve, 80))

  const second = mockCtx()
  await (await import('../index.js')).apply(second.ctx)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const nq = second.registrations.tools.find((t) => t.name === 'next_question')
  const agent2 = { session: mockSession('/restore-workspace') }
  // A real restarted session folds teacher/mode back from its persisted log.
  agent2.session.append('teacher/mode', { active: true, course: 'Networking review' })
  const result = await nq.execute({ index: 0 }, { agent: agent2 })
  assert.ok(result.prompt.length > 0)
  assert.equal(result.total, 3)
})

test('a fresh session is hydrated from the store at pre-step (no re-import)', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)
  const imp = registrations.tools.find((t) => t.name === 'import_curriculum')
  const preStep = registrations.events['agent/pre-step'][0]
  assert.ok(registrations.events['agent/session-start'], 'agent/session-start listener registered')

  // Load a course into the store under a directory workspace.
  const loader = { session: mockSession('/hydrate-ws') }
  await imp.execute({ courseTitle: 'Hydrate', markdown: '## Q1: A?\n<!-- answer: a -->\n## Q2: B?\n<!-- answer: b -->\n' }, { agent: loader })
  await new Promise((resolve) => setTimeout(resolve, 80))

  // A brand-new session (empty log, same workspace, distinct id) hydrates at pre-step.
  const fresh = { session: { id: 's-fresh', meta: { cwd: '/hydrate-ws' }, events: [], append(type, data) { this.events.push({ type, data }) } } }
  await preStep({ agent: fresh }, () => {})
  const courseEvent = fresh.session.events.find((e) => e.type === 'teacher/course')
  assert.ok(courseEvent, 'teacher/course appended on hydration')
  assert.equal(courseEvent.data.title, 'Hydrate')
  assert.equal(courseEvent.data.questions.length, 2)
  for (const q of courseEvent.data.questions) {
    assert.equal('answer' in q, false, 'hydrated course event must not carry answer keys')
  }
  // Idempotent: a second pre-step does not re-append.
  const before = fresh.session.events.length
  await preStep({ agent: fresh }, () => {})
  assert.equal(fresh.session.events.length, before)
})

test('hydration falls back to the latest directory-keyed course for cwd-less sessions', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)
  const imp = registrations.tools.find((t) => t.name === 'import_curriculum')
  const preStep = registrations.events['agent/pre-step'][0]

  const loader = { session: mockSession('/dir-ws') }
  await imp.execute({ courseTitle: 'DirCourse', markdown: '## Q1: A?\n<!-- answer: a -->\n' }, { agent: loader })
  await new Promise((resolve) => setTimeout(resolve, 80))

  // A session with NO cwd key (workspaceOf = session id) inherits the course.
  const noCwd = { session: { id: 's-no-cwd', events: [], meta: {}, append(type, data) { this.events.push({ type, data }) } } }
  await preStep({ agent: noCwd }, () => {})
  const courseEvent = noCwd.session.events.find((e) => e.type === 'teacher/course')
  assert.ok(courseEvent, 'cwd-less session hydrated from directory fallback')
  assert.equal(courseEvent.data.title, 'DirCourse')
})

test('/course lists courses and switches the active one', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)
  const imp = registrations.tools.find((t) => t.name === 'import_curriculum')
  const courseCmd = registrations.commands.find((c) => c.name === 'course')
  const nq = registrations.tools.find((t) => t.name === 'next_question')

  const agent = { session: mockSession('/course-ws') }
  await imp.execute({ courseTitle: 'English', markdown: '## Q1: A?\n<!-- answer: a -->\n' }, { agent })
  await imp.execute({ courseTitle: 'Science', markdown: '## Q1: X?\n<!-- answer: x -->\n## Q2: Y?\n<!-- answer: y -->\n' }, { agent })
  await new Promise((resolve) => setTimeout(resolve, 80))

  // list shows both, active is the most recent (Science)
  const listed = await courseCmd.handler({ agent, rawInput: '' })
  assert.ok(listed.text.includes('English'))
  assert.ok(listed.text.includes('Science'))
  assert.ok(listed.text.includes('← active'))

  // switch to English
  const switched = await courseCmd.handler({ agent, rawInput: 'english' })
  assert.equal(switched.kind, 'success')
  assert.ok(switched.text.includes('English'))
  const courseEvent = agent.session.events.filter((e) => e.type === 'teacher/course').at(-1)
  assert.equal(courseEvent.data.title, 'English')

  // the tools now use the switched course
  const q = await nq.execute({ index: 0 }, { agent })
  assert.equal(q.total, 1)
  assert.ok(q.prompt.includes('A?'))

  // unknown title errors
  const missing = await courseCmd.handler({ agent, rawInput: 'nope' })
  assert.equal(missing.kind, 'error')
})

test('finishing a quiz auto-enters teacher mode and surfaces the pending run at pre-step', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx({ webServer: true })
  await apply(ctx)
  const imp = registrations.tools.find((t) => t.name === 'import_curriculum')
  const preStep = registrations.events['agent/pre-step'][0]
  const route = registrations.webRoutes.find((r) => r.path === '/dsh-teacher/quiz/submit')

  const agent = { session: mockSession('/auto-mode-ws') }
  await imp.execute({ courseTitle: 'Auto', markdown: '## Q1: A?\n<!-- answer: a -->\n' }, { agent })
  await new Promise((resolve) => setTimeout(resolve, 80))
  const courseEvent = agent.session.events.find((e) => e.type === 'teacher/course')
  // import_curriculum turns mode on; turn it off to exercise the auto-enter path.
  agent.session.append('teacher/mode', { active: false, course: null })

  // User finishes the quiz (popup POST) → run stored, no teacher mode yet.
  const req = {
    [Symbol.asyncIterator]: async function* () {
      yield JSON.stringify({ courseId: courseEvent.data.courseId, answers: [{ qid: 'q1', answer: 'b' }] })
    },
  }
  let status = 0
  await route.handler(req, { writeHead: (s) => { status = s }, end: () => {} })
  assert.equal(status, 200)
  const lastModeAfterSubmit = agent.session.events.filter((e) => e.type === 'teacher/mode').at(-1)
  assert.ok(lastModeAfterSubmit && lastModeAfterSubmit.data.active === false, 'mode still off right after submit')

  // Next pre-step (any user message) auto-enters teacher mode + surfaces the run.
  await preStep({ agent }, () => {})
  const mode = agent.session.events.find((e) => e.type === 'teacher/mode')
  assert.ok(mode && mode.data.active === true, 'teacher mode auto-entered')
  const runEvent = agent.session.events.find((e) => e.type === 'teacher/quiz-run')
  assert.ok(runEvent && runEvent.data.status === 'pending', 'pending run surfaced for the policy')

  // Idempotent: a second pre-step does not re-append mode/run events.
  const before = agent.session.events.length
  await preStep({ agent }, () => {})
  assert.equal(agent.session.events.length, before)
})

test('grade_answer and note_gap work without any loaded course when courseTitle is passed', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)
  const grade = registrations.tools.find((t) => t.name === 'grade_answer')
  const note = registrations.tools.find((t) => t.name === 'note_gap')

  // Fresh session: teacher mode on, but NO course loaded at all.
  const agent = { session: mockSession('/no-course-ws') }
  agent.session.append('teacher/mode', { active: true, course: null })
  assert.equal((await import('../index.js')).TeacherController && true, true)

  // note_gap with courseTitle files the gap under that course (no "no course loaded").
  const gap = await note.execute({
    questionId: 'q1', topic: 'gravity', userQuote: 'no idea', kind: 'missing', courseTitle: 'Science',
  }, { agent })
  assert.equal(gap.ok, true)
  assert.ok(gap.gapId)

  // grade_answer with courseTitle resolves that gap.
  const graded = await grade.execute({
    questionId: 'q1', userAnswer: 'gravity', verdict: 'correct', courseTitle: 'Science',
  }, { agent })
  assert.equal(graded.correct, true)
  assert.equal(graded.updated.length, 1)
  assert.equal(graded.updated[0].status, 'mastered')
})
