import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initGapProjection, applyGapProjection, viewGapProjection, TEACHER_GAPS_KEY,
} from '../lib/gap-projection.js'

function ev(type, data, time = 1) {
  return { type, data, time }
}

const GAP = { id: 'ws::c::q1::1', questionId: 'q1', topic: 'tcp', kind: 'wrong', status: 'open', dueAt: 100 }

test('empty log folds to empty state', () => {
  const state = initGapProjection()
  assert.deepEqual(viewGapProjection(state), { gaps: [], grades: [] })
})

test('teacher/gap events accumulate', () => {
  let state = initGapProjection()
  state = applyGapProjection(state, ev('teacher/gap', { gap: GAP }))
  state = applyGapProjection(state, ev('teacher/gap', { gap: { ...GAP, id: 'ws::c::q1::2', topic: 'rebase' } }))
  const view = viewGapProjection(state)
  assert.equal(view.gaps.length, 2)
  assert.equal(view.gaps[1].topic, 'rebase')
})

test('teacher/grade events append to grades, not gaps', () => {
  let state = initGapProjection()
  state = applyGapProjection(state, ev('teacher/gap', { gap: GAP }))
  state = applyGapProjection(state, ev('teacher/grade', { questionId: 'q1', verdict: 'wrong', rating: 1 }, 42))
  const view = viewGapProjection(state)
  assert.equal(view.gaps.length, 1)
  assert.equal(view.grades.length, 1)
  assert.equal(view.grades[0].verdict, 'wrong')
  assert.equal(view.grades[0].at, 42)
})

test('unrelated events return the same reference (zero-work contract)', () => {
  const state = initGapProjection()
  assert.equal(applyGapProjection(state, ev('user/message', {})), state)
  assert.equal(applyGapProjection(state, ev('teacher/mode', { active: true })), state)
})

test('key is stable', () => {
  assert.equal(TEACHER_GAPS_KEY, 'teacherGaps')
})
