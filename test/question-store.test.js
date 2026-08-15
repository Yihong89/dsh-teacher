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
  test(`[${kind}] upsertCourse/latestCourse round-trips a course in the shared pool`, async () => {
    await withStore(kind, (store) => {
      const course = parseCurriculum(SAMPLE)
      store.upsertCourse({ title: 'Networking', source: 'notes.md', questions: course.questions })

      const latest = store.latestCourse()
      assert.ok(latest !== null)
      assert.equal(latest.title, 'Networking')
      assert.equal(latest.source, 'notes.md')
      assert.equal(latest.questions.length, 2)
      // rows keep answer keys for the in-session course
      assert.equal(latest.questions[0].answer, 'a reliable connection-oriented protocol')
      assert.equal(latest.questions[1].answer, 'B')
      assert.equal(latest.questions[1].options.length, 2)
      assert.deepEqual(latest.questions[0].hints, ['three letters, connection-oriented'])
    })
  })

  test(`[${kind}] multiple courses with different titles coexist in the shared pool`, async () => {
    await withStore(kind, (store) => {
      const englishId = store.upsertCourse({ title: 'English', source: 'en.md', questions: parseCurriculum('## Q1: A?\n<!-- answer: a -->\n').questions })
      const scienceId = store.upsertCourse({ title: 'Science', source: 'sc.md', questions: parseCurriculum('## Q1: X?\n<!-- answer: x -->\n## Q2: Y?\n<!-- answer: y -->\n').questions })
      const mathId = store.upsertCourse({ title: 'Math', source: 'ma.md', questions: parseCurriculum('## Q1: M?\n<!-- answer: m -->\n').questions })

      const listed = store.listCourses()
      assert.equal(listed.length, 3)
      assert.deepEqual(listed.map((c) => c.title).sort(), ['English', 'Math', 'Science'])
      const byTitle = Object.fromEntries(listed.map((c) => [c.title, c]))
      assert.equal(byTitle.English.questionCount, 1)
      assert.equal(byTitle.Science.questionCount, 2)

      // latest is the most recently updated course
      assert.equal(store.latestCourse().title, 'Math')
      // courseById still resolves each
      assert.equal(store.courseById(englishId).title, 'English')
      assert.equal(store.courseById(scienceId).title, 'Science')
      assert.equal(store.courseById(mathId).title, 'Math')
    })
  })

  test(`[${kind}] upserting the same title replaces that course globally (id kept, others untouched)`, async () => {
    await withStore(kind, (store) => {
      const englishId = store.upsertCourse({ title: 'English', source: 'a.md', questions: parseCurriculum('## Q1: A?\n<!-- answer: a -->\n').questions })
      const scienceId = store.upsertCourse({ title: 'Science', source: 's.md', questions: parseCurriculum('## Q1: X?\n<!-- answer: x -->\n').questions })

      const again = store.upsertCourse({ title: 'English', source: 'b.md', questions: parseCurriculum('## Q1: A?\n<!-- answer: a -->\n## Q2: B?\n<!-- answer: b -->\n').questions })
      assert.equal(again, englishId, 'same title keeps the course id')

      const listed = store.listCourses()
      assert.equal(listed.length, 2, 'English replaced, Science untouched')
      const english = listed.find((c) => c.title === 'English')
      assert.equal(english.questionCount, 2)
      assert.equal(store.latestCourse().title, 'English')
      assert.equal(store.courseById(scienceId).questions.length, 1)
    })
  })

  test(`[${kind}] course selection preference is global (shared by every session)`, async () => {
    await withStore(kind, (store) => {
      const a = store.upsertCourse({ title: 'A', source: null, questions: parseCurriculum('## Q1: A?\n<!-- answer: a -->\n').questions })
      const b = store.upsertCourse({ title: 'B', source: null, questions: parseCurriculum('## Q1: B?\n<!-- answer: b -->\n').questions })
      assert.equal(store.getSelectedCourseId(), null)
      store.setSelectedCourseId(b)
      assert.equal(store.getSelectedCourseId(), b)
      store.setSelectedCourseId(a)
      assert.equal(store.getSelectedCourseId(), a)
    })
  })

  test(`[${kind}] listAllCourses returns every course with workspace and counts`, async () => {
    await withStore(kind, (store) => {
      store.upsertCourse({ workspace: '/ws/one', title: 'English', source: null, questions: parseCurriculum('## Q1: A?\n<!-- answer: a -->\n').questions })
      store.upsertCourse({ workspace: '/ws/two', title: 'Math', source: null, questions: parseCurriculum('## Q1: M?\n<!-- answer: m -->\n').questions })
      const all = store.listAllCourses()
      assert.equal(all.length, 2)
      assert.deepEqual(all.map((c) => c.title).sort(), ['English', 'Math'])
      assert.ok(all.every((c) => typeof c.workspace === 'string' && c.questionCount === 1))
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

  test(`[${kind}] courseById resolves a course (workspace is the global marker)`, async () => {
    await withStore(kind, (store) => {
      const courseId = store.upsertCourse({ title: 'ById', source: null, questions: parseCurriculum('## Q1: A?\n<!-- answer: a -->\n').questions })
      const byId = store.courseById(courseId)
      assert.ok(byId !== null)
      assert.equal(byId.workspace, 'global')
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

for (const kind of ['db', 'json']) {
  test(`[${kind}] latestPendingRun finds the most recent un-analyzed run globally`, async () => {
    await withStore(kind, (store) => {
      const cid = store.upsertCourse({ title: 'S', source: null, questions: parseCurriculum('## Q1: X?\n<!-- answer: x -->\n').questions })
      assert.equal(store.latestPendingRun(), null)
      const { runId: r1 } = store.createQuizRun({ workspace: 'global', courseId: cid, answers: [{ qid: 'q1', answer: 'a' }] })
      const { runId: r2 } = store.createQuizRun({ workspace: 'global', courseId: cid, answers: [{ qid: 'q1', answer: 'b' }] })
      const pending = store.latestPendingRun()
      assert.equal(pending.runId, r2, 'most recent pending run wins')
      store.markQuizRunAnalyzed(r2, null)
      assert.equal(store.latestPendingRun().runId, r1, 'analyzed runs are skipped')
    })
  })

  // (latestPendingRunDirectory removed — the store is global)
}
