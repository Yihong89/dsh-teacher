import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  foldTeacherState, teacherModeAtLastHeader, recentGaps, hasOpenTurn,
  MODE_EVENT, GAP_EVENT, GRADE_EVENT, QUIZ_EVENT,
} from '../lib/fold.js'

function ev(type, data) {
  return { type, data }
}

test('foldTeacherState: mode off by default, last mode wins, course tracked', () => {
  const events = [
    ev(MODE_EVENT, { active: true, course: 'A' }),
    ev(MODE_EVENT, { active: false, course: 'A' }),
  ]
  const folded = foldTeacherState(events)
  assert.equal(folded.active, false)
  assert.equal(folded.course, 'A')
  assert.deepEqual(folded.gaps, [])
})

test('foldTeacherState: gaps accumulate with mode', () => {
  const events = [
    ev(MODE_EVENT, { active: true, course: 'A' }),
    ev(GAP_EVENT, { gap: { id: 'g1', topic: 'tcp' } }),
    ev(GRADE_EVENT, { questionId: 'q1', verdict: 'wrong', rating: 1 }),
    ev(GAP_EVENT, { gap: { id: 'g2', topic: 'rebase' } }),
  ]
  const folded = foldTeacherState(events)
  assert.equal(folded.active, true)
  assert.equal(folded.gaps.length, 2)
  assert.equal(folded.gaps[1].topic, 'rebase')
})

test('foldTeacherState respects an end prefix', () => {
  const events = [ev(MODE_EVENT, { active: false, course: 'A' }), ev(MODE_EVENT, { active: true, course: 'A' })]
  assert.equal(foldTeacherState(events, 1).active, false)
  assert.equal(foldTeacherState(events).active, true)
})

test('teacherModeAtLastHeader reads state at the last request header', () => {
  const events = [
    ev('request/header', {}),
    ev(MODE_EVENT, { active: true, course: 'A' }),
    ev('request/header', {}),
    ev(MODE_EVENT, { active: false, course: 'A' }),
  ]
  // Mode on was in force when the last header was assembled.
  assert.equal(teacherModeAtLastHeader(events), true)
})

test('recentGaps limits to the newest records', () => {
  const events = [
    ev(GAP_EVENT, { gap: { id: 'g1' } }),
    ev(GAP_EVENT, { gap: { id: 'g2' } }),
    ev(GAP_EVENT, { gap: { id: 'g3' } }),
  ]
  assert.equal(recentGaps(events, 2).length, 2)
  assert.equal(recentGaps(events, 2)[0].id, 'g2')
  assert.equal(recentGaps(events).length, 3)
})

test('hasOpenTurn tracks turn start/end', () => {
  assert.ok(!hasOpenTurn([]))
  assert.ok(hasOpenTurn([ev('turn/start', {})]))
  assert.ok(!hasOpenTurn([ev('turn/start', {}), ev('turn/end', {})]))
})

test('quiz mode folds off by default and flips on last teacher/quiz event', () => {
  assert.equal(foldTeacherState([]).quiz, false)
  assert.equal(foldTeacherState([ev(QUIZ_EVENT, { active: true })]).quiz, true)
  const off = foldTeacherState([ev(QUIZ_EVENT, { active: true }), ev(QUIZ_EVENT, { active: false })])
  assert.equal(off.quiz, false)
})

test('quiz state survives alongside mode and gaps', () => {
  const events = [
    ev(MODE_EVENT, { active: true, course: 'A' }),
    ev(QUIZ_EVENT, { active: true }),
    ev(GAP_EVENT, { gap: { id: 'g1', topic: 'tcp' } }),
    ev(QUIZ_EVENT, { active: false }),
  ]
  const folded = foldTeacherState(events)
  assert.equal(folded.active, true)
  assert.equal(folded.quiz, false)
  assert.equal(folded.gaps.length, 1)
})
