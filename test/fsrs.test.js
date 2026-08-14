import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FSRS, createCard, review, Rating, STATE_NAME, DAY_MS } from '../lib/fsrs.js'

test('official FSRS-5 ivl_history vector (ts-fsrs reference)', () => {
  const fsrs = new FSRS()
  let card = createCard(Date.UTC(2022, 11, 29, 12, 30))
  let now = Date.UTC(2022, 11, 29, 12, 30)
  // Good×6, Again×2, Good×5
  const ratings = [3, 3, 3, 3, 3, 3, 1, 1, 3, 3, 3, 3, 3]
  const history = []
  for (const rating of ratings) {
    const { card: next } = review(fsrs, card, rating, now)
    history.push(next.scheduledDays)
    now = next.due
    card = next
  }
  assert.deepEqual(history, [0, 4, 14, 44, 125, 328, 0, 0, 7, 16, 34, 71, 142])
})

test('new card + Good lands in a learning step (0 days), then graduates', () => {
  const fsrs = new FSRS()
  const now = Date.UTC(2024, 0, 1)
  const first = review(fsrs, createCard(now), Rating.Good, now).card
  assert.equal(first.scheduledDays, 0)
  const second = review(fsrs, first, Rating.Good, first.due).card
  assert.equal(second.scheduledDays, 4)
  assert.equal(second.state, 2) // Review
})

test('new card + Easy goes straight to a review interval', () => {
  const fsrs = new FSRS()
  const now = Date.UTC(2024, 0, 1)
  const first = review(fsrs, createCard(now), Rating.Easy, now).card
  // Learning step for Easy: (1+10)/2? No — strategy: Easy has no entry,
  // so it graduates with S0(w[3])=15.69 → interval ~16.
  assert.equal(first.state, 2)
  assert.ok(first.scheduledDays >= 15)
})

test('forgetting curve returns ~0.9 at t = stability', () => {
  const fsrs = new FSRS()
  const r = fsrs.forgettingCurve(10, 10)
  assert.ok(Math.abs(r - 0.9) < 0.002)
})

test('same-day reviews grow stability (FSRS-5 short-term)', () => {
  const fsrs = new FSRS()
  const now = Date.UTC(2024, 0, 1)
  let card = createCard(now)
  card = review(fsrs, card, Rating.Good, now).card
  const sAfterFirst = card.stability
  card = review(fsrs, card, Rating.Good, card.due).card // elapsed 0
  assert.ok(card.stability > sAfterFirst)
})

test('hard interval is shorter than good interval', () => {
  const fsrs = new FSRS()
  const now = Date.UTC(2024, 0, 1)
  const base = review(fsrs, createCard(now), Rating.Good, now).card
  const good = review(fsrs, base, Rating.Good, base.due).card
  const base2 = review(fsrs, createCard(now), Rating.Good, now).card
  const hard = review(fsrs, base2, Rating.Hard, base2.due).card
  assert.ok(hard.scheduledDays < good.scheduledDays)
})

test('card state names cover the four states', () => {
  assert.deepEqual(STATE_NAME, ['new', 'learning', 'review', 'relearning'])
})

test('day arithmetic: elapsed days floors to whole days', () => {
  const fsrs = new FSRS()
  const now = Date.UTC(2024, 0, 1)
  let card = createCard(now)
  card = review(fsrs, card, Rating.Good, now).card
  // Review 10 hours later: still the same day → short-term path (0 elapsed)
  const late = now + 10 * 3_600_000
  const next = review(fsrs, card, Rating.Good, late).card
  assert.ok(next.stability > card.stability)
})
