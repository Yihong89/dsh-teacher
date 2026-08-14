/**
 * Durable gap ledger — SQLite via node:sqlite with a JSON-file fallback.
 *
 * Schema matches docs/PLAN.md §6. The store is path-agnostic; the host plugin
 * decides the file location ($DSH_HOME/state/dsh-teacher/ledger.*).
 *
 * A gap is one FSRS card: scheduling fields (stability/difficulty/interval/due)
 * are updated by grade_answer/retest through lib/fsrs.js.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS gaps (
  id            TEXT PRIMARY KEY,
  workspace     TEXT NOT NULL,
  course        TEXT NOT NULL,
  question_id   TEXT NOT NULL,
  topic         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  evidence      TEXT NOT NULL,
  confidence    INTEGER,
  status        TEXT NOT NULL DEFAULT 'open',
  interval_days REAL NOT NULL DEFAULT 1,
  ease          REAL NOT NULL DEFAULT 2.5,
  stability     REAL NOT NULL DEFAULT 1.0,
  difficulty    REAL NOT NULL DEFAULT 5.0,
  created_at    INTEGER NOT NULL,
  due_at        INTEGER,                  -- NULL once mastered (no next review)
  last_reviewed INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gaps_due ON gaps(workspace, status, due_at);
`

export const GAP_STATUS = Object.freeze({
  open: 'open',
  due: 'due',
  mastered: 'mastered',
  archived: 'archived',
})

const DB_TO_GAP = {
  question_id: 'questionId',
  interval_days: 'intervalDays',
  created_at: 'createdAt',
  due_at: 'dueAt',
  last_reviewed: 'lastReviewed',
}

const GAP_TO_DB = {
  questionId: 'question_id',
  intervalDays: 'interval_days',
  createdAt: 'created_at',
  dueAt: 'due_at',
  lastReviewed: 'last_reviewed',
}

function toDbKey(key) {
  return GAP_TO_DB[key] ?? key
}

function rowFromDb(row) {
  const gap = { ...row }
  for (const [dbKey, field] of Object.entries(DB_TO_GAP)) {
    gap[field] = gap[dbKey]
    delete gap[dbKey]
  }
  return gap
}

function nowMs() {
  return Date.now()
}

export function gapId(workspace, course, questionId, seq) {
  return `${workspace}::${course}::${questionId}::${seq}`
}

/** SQLite-backed store. */
class SqliteLedger {
  constructor(db) {
    this.db = db
  }

  addGap(gap) {
    this.db
      .prepare(
        `INSERT INTO gaps (id, workspace, course, question_id, topic, kind, evidence,
           confidence, status, interval_days, ease, stability, difficulty,
           created_at, due_at, last_reviewed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        gap.id, gap.workspace, gap.course, gap.questionId, gap.topic, gap.kind,
        gap.evidence, gap.confidence, gap.status, gap.intervalDays, gap.ease,
        gap.stability, gap.difficulty, gap.createdAt, gap.dueAt, gap.lastReviewed,
      )
  }

  listGaps({ workspace, course } = {}) {
    const rows = this.db
      .prepare(
        `SELECT * FROM gaps
         WHERE (? IS NULL OR workspace = ?) AND (? IS NULL OR course = ?)
         ORDER BY created_at ASC`,
      )
      .all(workspace ?? null, workspace ?? null, course ?? null, course ?? null)
    return rows.map(rowFromDb)
  }

  gapsForQuestion(workspace, course, questionId) {
    const rows = this.db
      .prepare(
        `SELECT * FROM gaps
         WHERE workspace = ? AND course = ? AND question_id = ? AND status != 'archived'
         ORDER BY created_at ASC`,
      )
      .all(workspace, course, questionId)
    return rows.map(rowFromDb)
  }

  dueGaps({ workspace, course, now = nowMs() }) {
    const rows = this.db
      .prepare(
        `SELECT * FROM gaps
         WHERE workspace = ? AND course = ? AND status = 'open' AND due_at <= ?
         ORDER BY due_at ASC`,
      )
      .all(workspace, course, now)
    return rows.map(rowFromDb)
  }

  updateGap(id, patch) {
    const fields = []
    const values = []
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      fields.push(`${toDbKey(key)} = ?`)
      values.push(value)
    }
    if (fields.length === 0) return
    values.push(id)
    this.db.prepare(`UPDATE gaps SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  close() {
    this.db.close()
  }
}

/** JSON-file store (fallback when node:sqlite is unavailable). */
class JsonLedger {
  constructor(filePath, gaps) {
    this.filePath = filePath
    this.gaps = gaps
  }

  addGap(gap) {
    this.gaps.push(gap)
    this.save()
  }

  listGaps({ workspace, course } = {}) {
    return this.gaps.filter(
      (g) =>
        (workspace === undefined || g.workspace === workspace) &&
        (course === undefined || g.course === course),
    )
  }

  gapsForQuestion(workspace, course, questionId) {
    return this.gaps.filter(
      (g) =>
        g.workspace === workspace &&
        g.course === course &&
        g.questionId === questionId &&
        g.status !== GAP_STATUS.archived,
    )
  }

  dueGaps({ workspace, course, now = nowMs() }) {
    return this.gaps.filter(
      (g) =>
        g.workspace === workspace &&
        g.course === course &&
        g.status === GAP_STATUS.open &&
        g.dueAt <= now,
    )
  }

  updateGap(id, patch) {
    const gap = this.gaps.find((g) => g.id === id)
    if (!gap) return
    Object.assign(gap, patch)
    this.save()
  }

  save() {
    writeFileSync(this.filePath, JSON.stringify(this.gaps, null, 2))
  }

  close() {}
}

export class LedgerStore {
  /**
   * Open a ledger at `filePath`. A `.db` path uses node:sqlite when available
   * and falls back to a sibling `.json` file otherwise; a `.json` path always
   * uses the JSON store.
   * @returns {Promise<{ store: object, kind: 'sqlite'|'json' }>}
   */
  static async open(filePath) {
    mkdirSync(dirname(filePath), { recursive: true })
    if (filePath.endsWith('.json')) {
      let gaps = []
      try {
        gaps = JSON.parse(readFileSync(filePath, 'utf8'))
      } catch {
        /* first run */
      }
      return { store: new JsonLedger(filePath, gaps), kind: 'json' }
    }
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(filePath)
      db.exec(SQL_SCHEMA)
      return { store: new SqliteLedger(db), kind: 'sqlite' }
    } catch (error) {
      return LedgerStore.open(filePath.replace(/\.db$/, '.json'))
    }
  }
}
