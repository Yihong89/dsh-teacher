import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LedgerStore, GAP_STATUS, gapId } from '../lib/ledger.js'

function makeGap(overrides = {}) {
  return {
    id: gapId('ws', 'course', 'q1', 1),
    workspace: 'ws',
    course: 'course',
    questionId: 'q1',
    topic: 'tcp handshake',
    kind: 'wrong',
    evidence: 'it just fails',
    confidence: 3,
    status: GAP_STATUS.open,
    intervalDays: 1,
    ease: 2.5,
    stability: 1,
    difficulty: 5,
    createdAt: 1_000,
    dueAt: 1_000 + 86_400_000,
    lastReviewed: null,
    ...overrides,
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-teacher-test-'))
}

test('SQLite ledger: add, list, filter, due, update, master', async () => {
  const dir = tempDir()
  try {
    const { store, kind } = await LedgerStore.open(join(dir, 'ledger.db'))
    assert.equal(kind, 'sqlite')

    store.addGap(makeGap())
    store.addGap(makeGap({ id: gapId('ws', 'course', 'q1', 2), kind: 'vague', topic: 'rebase', dueAt: 2_000 }))
    store.addGap(makeGap({ id: gapId('ws', 'other', 'q1', 1), course: 'other' }))

    assert.equal(store.listGaps({ workspace: 'ws', course: 'course' }).length, 2)
    assert.equal(store.gapsForQuestion('ws', 'course', 'q1').length, 2)
    // gap1 dueAt = 86_401_000; gap2 dueAt = 2_000
    assert.equal(store.dueGaps({ workspace: 'ws', course: 'course', now: 2_000 }).length, 1)
    assert.equal(store.dueGaps({ workspace: 'ws', course: 'course', now: 86_401_000 }).length, 2)

    store.updateGap(gapId('ws', 'course', 'q1', 1), { status: GAP_STATUS.mastered, dueAt: null })
    const updated = store.gapsForQuestion('ws', 'course', 'q1')
    assert.equal(updated[0].status, GAP_STATUS.mastered)
    assert.equal(updated[0].dueAt, null)
    // mastered gaps are excluded from due
    assert.equal(store.dueGaps({ workspace: 'ws', course: 'course', now: 99_999_999 }).length, 1)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('JSON ledger fallback works end to end and persists', async () => {
  const dir = tempDir()
  const file = join(dir, 'ledger.json')
  try {
    const { store, kind } = await LedgerStore.open(file)
    assert.equal(kind, 'json')
    store.addGap(makeGap())
    store.close()

    const reopened = await LedgerStore.open(file)
    const gaps = reopened.store.listGaps({ workspace: 'ws', course: 'course' })
    assert.equal(gaps.length, 1)
    assert.equal(gaps[0].topic, 'tcp handshake')
    reopened.store.updateGap(gaps[0].id, { status: GAP_STATUS.mastered })
    reopened.store.close()

    const third = await LedgerStore.open(file)
    assert.equal(third.store.listGaps({ workspace: 'ws' })[0].status, GAP_STATUS.mastered)
    third.store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger survives reopen via sqlite file', async () => {
  const dir = tempDir()
  const file = join(dir, 'ledger.db')
  try {
    const { store } = await LedgerStore.open(file)
    store.addGap(makeGap({ id: gapId('ws', 'c', 'q9', 1), course: 'c', topic: 'fsrs' }))
    store.close()
    const { store: again } = await LedgerStore.open(file)
    assert.equal(again.listGaps({ workspace: 'ws', course: 'c' })[0].topic, 'fsrs')
    again.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
