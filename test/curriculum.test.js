import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseCurriculum, stripComments, publicQuestions, isCollectionFormat,
} from '../lib/curriculum.js'

const FIXTURE = readFileSync(
  join(dirname(dirname(fileURLToPath(import.meta.url))), 'test', 'fixtures', 'wrong-answers-collection.md'),
  'utf8',
)

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

// ---- wrong-answers collection format --------------------------------------

test('collection format is auto-detected', () => {
  assert.ok(isCollectionFormat(FIXTURE))
  assert.ok(!isCollectionFormat(SAMPLE))
})

test('collection: title from H1, sections and passages attached', () => {
  const course = parseCurriculum(FIXTURE)
  assert.equal(course.title, 'Sample Wrong Answers Collection')
  const q1 = course.questions.find((q) => q.number === '1')
  assert.equal(q1.section, 'Fill-in-the-Blank')
  assert.equal(q1.passage, 'Amphibians')
})

test('collection: fill-in items get answer + Key words/Trap hints', () => {
  const course = parseCurriculum(FIXTURE)
  const q1 = course.questions.find((q) => q.prompt.includes('croak'))
  assert.equal(q1.answer, 'croaks')
  assert.equal(q1.hints.length, 2)
  assert.ok(q1.hints[0].includes('every night'))
  assert.ok(q1.hints[1].includes('bare form'))
  assert.ok(!q1.answer.includes('**'))
})

test('collection: multiple-choice items get options + correct answer', () => {
  const course = parseCurriculum(FIXTURE)
  const q43 = course.questions.find((q) => q.number === '43')
  assert.deepEqual(q43.options, ['rang', 'has rung', 'has been ringing', 'had been ringing'])
  assert.equal(q43.answer, 'had been ringing')
  assert.equal(q43.section, 'Multiple Choice')
})

test('collection: option lines starting with **✅ still parse', () => {
  const course = parseCurriculum(FIXTURE)
  const q44 = course.questions.find((q) => q.number === '44')
  assert.deepEqual(q44.options, ['tasted', 'tastes', 'is tasting', 'has tasted'])
  assert.equal(q44.answer, 'tasted')
})

test('collection: restarted numbering gets passage-scoped ids', () => {
  const course = parseCurriculum(FIXTURE)
  const ids = course.questions.map((q) => q.id)
  assert.equal(new Set(ids).size, ids.length)
  const vt2 = course.questions.find((q) => q.passage === 'Grammar: Verb Tenses' && q.number === '2')
  assert.equal(vt2.id, 'grammar-verb-tenses-2')
  assert.equal(course.questions.find((q) => q.passage === 'Amphibians' && q.number === '1').id, 'q1')
})

test('collection: bare numbered explanation steps are dropped', () => {
  const course = parseCurriculum(FIXTURE)
  assert.ok(!course.questions.some((q) => q.prompt.includes('Original object')))
  assert.equal(course.questions.length, 6)
})

test('collection: blanks normalized and answers never leaked', () => {
  const course = parseCurriculum(FIXTURE)
  const q43 = course.questions.find((q) => q.number === '43')
  assert.ok(q43.prompt.includes('____'))
  for (const q of publicQuestions(course)) {
    assert.ok(!('answer' in q))
    assert.ok(!('correct' in q))
  }
})

test('publicQuestions output is lossless JSON (no undefined values)', () => {
  const { course } = (() => {
    const parsed = parseCurriculum(
      '1. prompt → **Answer:** X\n' +
      '2. Which is right?\nA. opt1\nB. opt2 ✅\n' +
      '3. prompt with no options\n→ **Answer:** Y\n',
    )
    return { course: parsed }
  })()
  const rows = publicQuestions(course)
  for (const row of rows) {
    const roundTripped = JSON.parse(JSON.stringify(row))
    assert.deepEqual(row, roundTripped, `row ${row.id} must round-trip losslessly`)
  }
})
