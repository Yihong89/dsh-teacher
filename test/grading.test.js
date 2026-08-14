import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gapKindForVerdict, ratingForVerdict, isCorrect, buildGap, isGapKind, verdictLabel,
} from '../lib/grading.js'
import { Rating } from '../lib/fsrs.js'

test('verdict → gap kind mapping', () => {
  assert.equal(gapKindForVerdict('partial'), 'vague')
  assert.equal(gapKindForVerdict('wrong'), 'wrong')
  assert.equal(gapKindForVerdict('no-answer'), 'missing')
  assert.equal(gapKindForVerdict('correct'), null)
})

test('verdict → FSRS rating', () => {
  assert.equal(ratingForVerdict('correct'), Rating.Good)
  assert.equal(ratingForVerdict('partial'), Rating.Hard)
  assert.equal(ratingForVerdict('wrong'), Rating.Again)
  assert.equal(ratingForVerdict('no-answer'), Rating.Again)
})

test('isCorrect', () => {
  assert.ok(isCorrect('correct'))
  assert.ok(!isCorrect('partial'))
  assert.ok(!isCorrect('no-answer'))
})

test('buildGap trims and clamps confidence', () => {
  const gap = buildGap({
    questionId: 'q1', topic: '  tcp  ', userQuote: ' idk ', kind: 'missing', confidence: 9,
  })
  assert.equal(gap.topic, 'tcp')
  assert.equal(gap.evidence, 'idk')
  assert.equal(gap.confidence, 5)
  assert.equal(buildGap({ questionId: 'q1', topic: 't', userQuote: 'u', kind: 'wrong' }).confidence, null)
  assert.equal(buildGap({ questionId: 'q1', topic: 't', userQuote: 'u', kind: 'wrong', confidence: 0 }).confidence, 1)
})

test('isGapKind validates kinds', () => {
  for (const kind of ['wrong', 'vague', 'missing', 'exposed']) assert.ok(isGapKind(kind))
  assert.ok(!isGapKind('mastered'))
})

test('verdictLabel', () => {
  assert.equal(verdictLabel('correct'), 'correct')
  assert.equal(verdictLabel('partial'), 'partially correct')
  assert.equal(verdictLabel('nope'), 'nope')
})
