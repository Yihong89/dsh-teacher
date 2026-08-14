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
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
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

before(() => {
  stubDir = installToolStub()
})

test('host plugin registers section, commands, tools, and the gap projection', async () => {
  const { apply } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await apply(ctx)

  assert.equal(registrations.sections.length, 1)
  assert.equal(registrations.sections[0].name, 'teacher:policy')

  assert.deepEqual(
    registrations.commands.map((c) => c.name).sort(),
    ['gaps', 'retest', 'teach'],
  )
  assert.deepEqual(
    registrations.tools.map((t) => t.name).sort(),
    ['grade_answer', 'hint', 'next_question', 'note_gap', 'retest'],
  )
  assert.ok(registrations.events['agent/pre-step'])
  assert.equal(registrations.projections.length, 1)
  assert.equal(registrations.projections[0].key, 'teacherGaps')
  assert.equal(registrations.projections[0].stateVersion, 1)
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
  assert.ok(text.includes('知识缺失回退'))
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

test.after(() => {
  if (stubDir) rmSync(join(REPO_ROOT, 'node_modules'), { recursive: true, force: true })
})
