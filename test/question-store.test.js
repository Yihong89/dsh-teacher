/**
 * Question store: SQLite (node:sqlite) and JSON-fallback round trips for
 * courses, questions, and quiz runs, plus the public/key-free separation.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuestionStore, publicQuestion } from '../lib/question-store.js'
import { parseCurriculum } from '../lib/curriculum.js'

const SAMPLE = [
  '## Q1: What is TCP?',
  '<!-- answer: a reliable connection-oriented protocol -->',
  '<!-- hint 1: three letters, connection-oriented -->',
  '## Q2: Choose one.',
  '<!-- options: A. cat | B. dog -->',
  '<!-- answer: B -->',
].join('\n')

async function openTempStore(kind = 'db') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-teacher-store-'))
  const path = join(dir, kind === 'json' ? 'store.json' : 'store.db')
  const { store } = await QuestionStore.open(path)
  return { dir, store, path }
}

async function withStore(kind, fn) {
  const { dir, store, path } = await openTempStore(kind)
  try {
    await fn(store, path)
  } finally {
    try { store.close() } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const kind of ['db', 'json']) {
  test(`[${kind}] upsertCourse/latestCourse round-trips a course by workspace`, async () => {
    await withStore(kind, (store) => {
      const course = parseCurriculum(SAMPLE)
      const workspace = '/Users/me/projects/demo'
      store.upsertCourse({ workspace, title: 'Networking', source: 'notes.md', questions: course.questions })

      const latest = store.latestCourse(workspace)
      assert.ok(latest !== null)
      assert.equal(latest.title, 'Networking')
      assert.equal(latest.source, 'notes.md')
      assert.equal(latest.questions.length, 2)
      // rows keep answer keys for the in-session course
      assert.equal(latest.questions[0].answer, 'a reliable connection-oriented protocol')
      assert.equal(latest.questions[1].answer, 'B')
      assert.equal(latest.questions[1].options.length, 2)
      assert.deepEqual(latest.questions[0].hints, ['three letters, connection-oriented'])
      // a second workspace has no course
      assert.equal(store.latestCourse('/other/workspace'), null)
    })
  })

  test(`[${kind}] upsert replaces the previous course for the same workspace`, async () => {
    await withStore(kind, (store) => {
      const ws = '/ws/replace'
      store.upsertCourse({ workspace: ws, title: 'Old', source: 'a.md', questions: parseCurriculum('## Q1: A?\n<!-- answer: a -->\n').questions })
      const courseId = store.upsertCourse({ workspace: ws, title: 'New', source: 'b.md', questions: parseCurriculum('## Q1: A?\n<!-- answer: a -->\n## Q2: B?\n<!-- answer: b -->\n').questions })
      const latest = store.latestCourse(ws)
      assert.equal(latest.title, 'New')
      assert.equal(latest.questions.length, 2)
      assert.equal(latest.courseId, courseId)
      assert.equal(store.latestCourse(ws).courseId, courseId)
    })
  })

  test(`[${kind}] publicCourse omits answer keys but keeps options and hints`, async () => {
    await withStore(kind, (store) => {
      const ws = '/ws/public'
      store.upsertCourse({ workspace: ws, title: 'Pub', source: 's.md', questions: parseCurriculum(SAMPLE).questions })
      const pub = store.publicCourse(ws)
      assert.ok(pub !== null)
      for (const q of pub.questions) {
        assert.equal('answer' in q, false, `public question must not carry an answer key`)
        assert.equal('answerKey' in q, false)
      }
      assert.equal(pub.questions[1].options.length, 2)
      assert.equal(pub.questions[0].hints.length, 1)
    })
  })

  test(`[${kind}] courseById resolves a course with its workspace`, async () => {
    await withStore(kind, (store) => {
      const ws = '/ws/byid'
      const courseId = store.upsertCourse({ workspace: ws, title: 'ById', source: null, questions: parseCurriculum('## Q1: A?\n<!-- answer: a -->\n').questions })
      const byId = store.courseById(courseId)
      assert.ok(byId !== null)
      assert.equal(byId.workspace, ws)
      assert.equal(byId.title, 'ById')
      assert.equal(byId.questions.length, 1)
      assert.equal(store.courseById(999999), null)
    })
  })

  test(`[${kind}] quiz run lifecycle: create → get → mark analyzed`, async () => {
    await withStore(kind, (store) => {
      const ws = '/ws/quiz'
      const courseId = store.upsertCourse({ workspace: ws, title: 'Quiz', source: null, questions: parseCurriculum(SAMPLE).questions })
      const { runId } = store.createQuizRun({
        workspace: ws,
        courseId,
        answers: [{ qid: 'q1', answer: 'tcp' }, { qid: 'q2', answer: '' }],
      })
      const run = store.getQuizRun(runId)
      assert.equal(run.status, 'pending')
      assert.equal(run.answers.length, 2)
      assert.equal(run.answers[0].answer, 'tcp')
      assert.equal(run.course.title, 'Quiz')
      assert.equal(run.course.questions.length, 2)

      store.markQuizRunAnalyzed(runId, { verdicts: [{ qid: 'q1', verdict: 'correct' }] })
      const analyzed = store.getQuizRun(runId)
      assert.equal(analyzed.status, 'analyzed')
      assert.equal(analyzed.analysis.verdicts[0].verdict, 'correct')
      assert.equal(store.getQuizRun(424242), null)
    })
  })

  test(`[${kind}] json fallback persists to disk`, async () => {
    await withStore(kind === 'json' ? 'json' : 'json', (store, path) => {
      const ws = '/ws/json'
      store.upsertCourse({ workspace: ws, title: 'J', source: null, questions: parseCurriculum('## Q1: A?\n<!-- answer: a -->\n').questions })
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      assert.ok(raw.courses.length === 1)
      assert.ok(raw.questions.length === 1)
    })
  })
}

test('publicQuestion includes options and hints but never the answer', () => {
  const q = {
    id: 'q1', prompt: 'P?', answer: 'secret', inlineAnswer: null,
    hints: ['h1'], options: ['A', 'B'], section: 'S', passage: null,
  }
  const pub = publicQuestion(q)
  assert.deepEqual(pub, {
    id: 'q1', prompt: 'P?', hintCount: 1, hints: ['h1'], options: ['A', 'B'], section: 'S',
  })
})
