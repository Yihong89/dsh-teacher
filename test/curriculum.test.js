import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCurriculum, stripComments, publicQuestions,
} from '../lib/curriculum.js'

const SAMPLE = `---
title: Networking review
lang: en
---
## Q1: What happens when TCP handshake fails?
<!-- answer: SYN is sent; SYN-ACK returned; ACK completes the connection -->

### hints
<!-- hint 1: Think about the three-way handshake. -->
<!-- hint 2: Which flag opens the connection? -->

## Q2: Why does rebase rewrite history?

Some body text that is not part of the question.
<!-- answer: Rebase replays each commit as a patch onto the new base, producing new hashes -->
<!-- hint 1: Compare with merge. -->
`

test('parseCurriculum extracts title and lang from frontmatter', () => {
  const course = parseCurriculum(SAMPLE)
  assert.equal(course.title, 'Networking review')
  assert.equal(course.lang, 'en')
})

test('parseCurriculum extracts questions with ids, prompts, answers, hints', () => {
  const course = parseCurriculum(SAMPLE)
  assert.equal(course.questions.length, 2)
  const [q1, q2] = course.questions
  assert.equal(q1.id, 'q1')
  assert.equal(q1.prompt, 'What happens when TCP handshake fails?')
  assert.equal(q1.answer, 'SYN is sent; SYN-ACK returned; ACK completes the connection')
  assert.deepEqual(q1.hints, [
    'Think about the three-way handshake.',
    'Which flag opens the connection?',
  ])
  assert.equal(q2.id, 'q2')
  assert.equal(q2.answer, 'Rebase replays each commit as a patch onto the new base, producing new hashes')
})

test('parseCurriculum tolerates missing frontmatter and answerless questions', () => {
  const course = parseCurriculum('## What is X?\nBody text.')
  assert.equal(course.title, null)
  assert.equal(course.questions.length, 1)
  assert.equal(course.questions[0].answer, null)
  assert.equal(course.questions[0].id, 'what-is-x')
})

test('questions without Q prefix get slug ids, unique-ified', () => {
  const course = parseCurriculum('## What is X?\n## What is X?\n')
  assert.equal(course.questions.length, 2)
  assert.equal(course.questions[0].id, 'what-is-x')
  assert.equal(course.questions[1].id, 'what-is-x-2')
})

test('stripComments removes all HTML comments', () => {
  const stripped = stripComments(SAMPLE)
  assert.ok(!stripped.includes('answer:'))
  assert.ok(!stripped.includes('<!--'))
  assert.ok(stripped.includes('What happens when TCP handshake fails?'))
})

test('publicQuestions never exposes answers', () => {
  const course = parseCurriculum(SAMPLE)
  for (const q of publicQuestions(course)) {
    assert.ok(!('answer' in q))
    assert.equal(typeof q.prompt, 'string')
    assert.equal(typeof q.hintCount, 'number')
    assert.equal(typeof q.hasAnswer, 'boolean')
  }
  assert.equal(publicQuestions(course)[0].hintCount, 2)
})

test('hints inside ### hints without numbers are collected', () => {
  const course = parseCurriculum('## Q1: P?\n### hints\n<!-- gentle nudge -->\n<!-- stronger nudge -->\n')
  assert.deepEqual(course.questions[0].hints, ['gentle nudge', 'stronger nudge'])
})
