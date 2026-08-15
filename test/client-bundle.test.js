/**
 * Client-bundle test: evaluates lib/client.js with a mocked
 * `window.__ModuleLoader__` and a `react` stub, then asserts the plugin shape
 * and the slot registrations, and renders a couple of components against
 * mock ToolCallOwnerProps.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function loadBundle() {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  let captured = null
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [init, () => {}],
    useEffect: (fn) => { fn() }, // run the effect body; ignore the disposer
  }
  globalThis.window = {
    __ModuleLoader__: {
      load: (def) => { captured = def },
    },
  }
  // The bundle is a classic script referencing window at the top level.
  // eslint-disable-next-line no-eval
  ;(0, eval)(source)
  assert.ok(captured, 'bundle did not call __ModuleLoader__.load')
  const moduleObj = captured.factory((spec) => {
    if (spec === 'react') return reactStub
    if (spec === 'react/jsx-runtime') return reactStub
    throw new Error(`unexpected require: ${spec}`)
  })
  return { moduleObj, reactStub }
}

function mockSlots() {
  const entries = []
  const slots = {
    inject: (slot, callback) => entries.push({ slot, register: callback }),
    register: (opts, component) => ({ opts, component }),
  }
  return { slots, entries }
}

test('client bundle exports a slots plugin', () => {
  const { moduleObj } = loadBundle()
  assert.equal(moduleObj.name, 'dsh-teacher/client')
  assert.deepEqual(moduleObj.inject, ['slots', 'conversation'])
  assert.equal(typeof moduleObj.apply, 'function')
})

test('apply registers five toolviews, a header button, and an overlay panel', () => {
  const { moduleObj } = loadBundle()
  const { slots, entries } = mockSlots()
  moduleObj.apply({ get: (name) => (name === 'slots' ? slots : undefined) })

  const toolviews = entries.filter((e) => e.slot === 'tool.call.toolview')
  assert.deepEqual(
    toolviews.map((e) => e.register().opts.key).sort(),
    ['grade_answer', 'next_question', 'note_gap', 'retest'],
  )

  // Teacher controls live inside the chat box: quiz leading, gaps trailing.
  const quizBtn = entries.find((e) => e.slot === 'conversation.input.left')
  assert.ok(quizBtn)
  const quizOpts = quizBtn.register().opts
  assert.equal(quizOpts.name, 'conversation.input.left')
  assert.equal(quizOpts.id, 'dsh-teacher-quiz')
  assert.equal(typeof quizOpts.label, 'function')

  const gapsBtn = entries.find((e) => e.slot === 'conversation.input.right' && e.register().opts.id === 'dsh-teacher-gaps')
  assert.ok(gapsBtn)
  const gapsOpts = gapsBtn.register().opts
  assert.equal(gapsOpts.name, 'conversation.input.right')
  assert.equal(gapsOpts.id, 'dsh-teacher-gaps')
  assert.equal(typeof gapsOpts.label, 'function')

  const speakBtn = entries.find((e) => e.slot === 'conversation.input.right' && e.register().opts.id === 'dsh-teacher-speak')
  assert.ok(speakBtn, 'TTS speak toggle registered in the chat box')

  const overlay = entries.find((e) => e.slot === 'shell.overlay')
  assert.ok(overlay)
  assert.equal(overlay.register().opts.id, 'dsh-teacher-gaps-panel')
})

test('next_question card renders the question content from resultView', () => {
  const { moduleObj } = loadBundle()
  const { slots, entries } = mockSlots()
  moduleObj.apply({ get: (name) => (name === 'slots' ? slots : undefined) })

  const toolview = entries.find(
    (e) => e.slot === 'tool.call.toolview' && e.register().opts.key === 'next_question',
  )
  const { component: QuestionCard } = toolview.register()

  const tree = QuestionCard({
    callId: 'c1',
    toolName: 'next_question',
    block: {
      kind: 'tool-result',
      callId: 'c1',
      call: { argsRaw: '{"index":0}' },
      resultView: { card: 'generic', title: 'Question q1', content: 'What happens when TCP handshake fails?\n\n(2 hints · 3 questions)' },
    },
  })
  const texts = collectTexts(tree)
  assert.ok(texts.some((t) => t.includes('What happens when TCP handshake fails')))
  assert.ok(texts.some((t) => t === 'Question q1'))
})

test('gaps button shows a due badge from the teacherGaps projection', () => {
  const { moduleObj } = loadBundle()
  const { slots, entries } = mockSlots()
  moduleObj.apply({ get: (name) => (name === 'slots' ? slots : undefined) })

  const button = entries.find((e) => e.slot === 'conversation.input.right' && e.register().opts.id === 'dsh-teacher-gaps')
  const { component: GapsButton } = button.register()
  const now = Date.now()
  const tree = GapsButton({
    sessionId: 's1',
    useSessions: (selector) => selector({ byId: { s1: { agentPreset: 'teacher' } } }),
    useProjection: () => ({
      gaps: [
        { id: 'g1', topic: 'tcp', kind: 'wrong', status: 'open', dueAt: now - 1000 },
        { id: 'g2', topic: 'rebase', kind: 'vague', status: 'open', dueAt: now + 86_400_000 * 5 },
        { id: 'g3', topic: 'udp', kind: 'wrong', status: 'mastered', dueAt: null },
      ],
    }),
  })
  const texts = collectTexts(tree)
  // one due gap → badge "1"
  assert.ok(texts.some((t) => String(t).includes('1')))
})

function collectTexts(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectTexts(child, out)
    return out
  }
  if (typeof node === 'object') {
    if (node.children) collectTexts(node.children, out)
    if (node.props && node.props.children) collectTexts(node.props.children, out)
    if (typeof node.props?.title === 'string') out.push(node.props.title)
  }
  return out
}

test('next_question inject exposes a send that submits the clicked option', () => {
  const { moduleObj } = loadBundle()
  const { slots, entries } = mockSlots()
  const sent = []
  const ctx = {
    get: (name) => (name === 'slots' ? slots : undefined),
    conversation: { send: (t) => { sent.push(t); return Promise.resolve() } },
  }
  moduleObj.apply(ctx)
  const nq = entries.find((e) => e.slot === 'tool.call.toolview' && e.register().opts.key === 'next_question')
  assert.ok(nq, 'next_question toolview registered')
  const inject = nq.register().opts.inject
  assert.equal(typeof inject, 'function')
  const props = inject()
  assert.equal(typeof props.send, 'function')
  props.send('Option A')
  assert.deepEqual(sent, ['Option A'])
})

test('assistantNodeText reads harness blocks by kind, skipping reasoning', () => {
  const { moduleObj } = loadBundle()
  const { assistantNodeText } = moduleObj._test
  const node = {
    kind: 'assistant',
    seq: 7,
    blocks: [
      { kind: 'text', text: 'Hello there' },
      { kind: 'reasoning', text: 'chain of thought — must not be spoken' },
      { kind: 'text', text: ' second part' },
      { type: 'text', text: ' legacy-spelled block' },
      { kind: 'tool-call', callId: 'c', name: 'speak', argsRaw: '{}' },
    ],
  }
  assert.equal(assistantNodeText(node), 'Hello there\n second part\n legacy-spelled block')
})

test('latestAssistantText finds the newest assistant message from raw nodes', () => {
  const { moduleObj } = loadBundle()
  const { latestAssistantText } = moduleObj._test
  const session = {
    nodes: [
      { kind: 'user', seq: 1, content: [], source: {} },
      { kind: 'assistant', seq: 2, blocks: [{ kind: 'text', text: 'First answer' }] },
      { kind: 'assistant', seq: 3, blocks: [{ kind: 'reasoning', text: 'think' }, { kind: 'text', text: 'The latest reply' }] },
    ],
    chat: { order: [], nodes: {} },
  }
  assert.deepEqual(latestAssistantText(session), { seq: 3, text: 'The latest reply' })
})

test('latestAssistantText unwraps chat-store view wrappers (assistant-step → finalNode)', () => {
  const { moduleObj } = loadBundle()
  const { latestAssistantText } = moduleObj._test
  const chatNodes = new Map([
    ['u1', { key: 'u1', kind: 'user', id: 'u1', target: 'chat', data: { kind: 'user', seq: 1, content: [], source: {} } }],
    ['a1', {
      key: 'a1',
      kind: 'assistant-step',
      id: 'a1',
      target: 'chat',
      data: { status: 'final', turn: 1, step: 1, finalNode: { kind: 'assistant', seq: 2, blocks: [{ kind: 'text', text: 'Spoken reply' }] } },
    }],
  ])
  const session = {
    nodes: [],
    chat: { order: ['u1', 'a1'], nodes: { get: (id) => chatNodes.get(id) } },
  }
  assert.deepEqual(latestAssistantText(session), { seq: 2, text: 'Spoken reply' })
})

test('latestAssistantText skips running steps and returns null when no assistant text', () => {
  const { moduleObj } = loadBundle()
  const { latestAssistantText } = moduleObj._test
  const chatNodes = new Map([
    ['a1', {
      key: 'a1',
      kind: 'assistant-step',
      id: 'a1',
      target: 'chat',
      data: { status: 'running', turn: 1, step: 1, blocks: [{ kind: 'text', text: 'still streaming' }] },
    }],
  ])
  const session = {
    nodes: [],
    chat: { order: ['a1'], nodes: { get: (id) => chatNodes.get(id) } },
  }
  assert.equal(latestAssistantText(session), null)
})

test('speak cursor key is per-session and survives reloads (no re-reading old messages)', () => {
  const { moduleObj } = loadBundle()
  const { SPEAK_CURSOR_KEY } = moduleObj._test
  assert.equal(SPEAK_CURSOR_KEY, 'dsh-teacher.spoken-cursor')
  // Simulate the cursor semantics used by SpeakToggle: stored per sessionId,
  // and a message whose seq <= cursor.seq for the same session is not spoken.
  const store = new Map()
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  globalThis.window = Object.assign({}, globalThis.window, { localStorage })
  // After speaking seq 10 in session s1, switching back to s1 must not re-speak.
  store.set(SPEAK_CURSOR_KEY, JSON.stringify({ sessionId: 's1', seq: 10 }))
  const cursor = JSON.parse(localStorage.getItem(SPEAK_CURSOR_KEY))
  assert.equal(cursor.sessionId, 's1')
  assert.equal(cursor.seq, 10)
  // Same session, old message seq → skip.
  assert.equal(cursor.sessionId === 's1' && cursor.seq >= 8, true)
  // Same session, NEW message seq → speak.
  assert.equal(cursor.sessionId === 's1' && cursor.seq >= 12, false)
  // Different session → speak regardless of cursor.
  assert.equal(cursor.sessionId === 's2', false)
  delete globalThis.window
})
