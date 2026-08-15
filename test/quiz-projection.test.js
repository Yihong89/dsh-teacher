/**
 * `teacherQuiz` projection: folds teacher/course, teacher/quiz, and
 * teacher/quiz-run events into the LLM-free quiz popup state.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initQuizProjection, applyQuizProjection, viewQuizProjection,
  quizProjectionWith, TEACHER_QUIZ_KEY,
} from '../lib/quiz-projection.js'

test('teacherQuiz folds course, quiz mode, and run status', () => {
  let state = initQuizProjection()
  assert.deepEqual(state, { course: null, quizActive: false, lastRun: null })

  state = applyQuizProjection(state, {
    type: 'teacher/course',
    data: { courseId: 7, title: 'Networking', source: 'notes.md', questions: [{ id: 'q1', prompt: 'A?' }] },
  })
  assert.equal(state.course.courseId, 7)
  assert.equal(state.course.title, 'Networking')
  assert.equal(state.course.questions.length, 1)
  assert.equal(state.quizActive, false)

  state = applyQuizProjection(state, { type: 'teacher/quiz', data: { active: true } })
  assert.equal(state.quizActive, true)
  assert.equal(state.course.title, 'Networking')

  state = applyQuizProjection(state, { type: 'teacher/quiz-run', data: { runId: 3, status: 'pending' } })
  assert.deepEqual(state.lastRun, { runId: 3, status: 'pending' })
  assert.equal(state.quizActive, true)

  // A later course replaces the course, keeps the run.
  state = applyQuizProjection(state, { type: 'teacher/course', data: { courseId: 8, title: 'Git', questions: [] } })
  assert.equal(state.course.courseId, 8)
  assert.deepEqual(state.lastRun, { runId: 3, status: 'pending' })

  const view = viewQuizProjection(state)
  assert.deepEqual(view, state)
})

test('teacherQuiz returns the same reference for unrelated events', () => {
  const state = initQuizProjection()
  const untouched = applyQuizProjection(state, { type: 'teacher/gap', data: { gap: {} } })
  assert.equal(untouched, state)
})

test('projection key and version are stable', () => {
  const def = quizProjectionWith({})
  assert.equal(def.key, 'teacherQuiz')
  assert.equal(def.stateVersion, 1)
  assert.equal(TEACHER_QUIZ_KEY, 'teacherQuiz')
})
