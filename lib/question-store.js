/**
 * Durable question store: courses, questions, and quiz runs in SQLite
 * (node:sqlite) with a JSON-file fallback — the same pattern as lib/ledger.js.
 *
 * The store is the v0.3 replacement for the v0.2 per-workspace JSON course
 * file: parsed question banks persist as rows, survive restarts, and feed the
 * LLM-free quiz popup. Answer keys live here server-side and are NEVER
 * included in the public view (publicCourse / teacher/course events).
 *
 * File: `$DSH_HOME/state/dsh-teacher/question-store.db` (override:
 * `DSH_TEACHER_STORE`); JSON fallback at the sibling `.json` path.
 * @module dsh-teacher/question-store
 */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const SQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS courses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace  TEXT NOT NULL,
  title      TEXT NOT NULL,
  source     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  qid        TEXT NOT NULL,
  position   INTEGER NOT NULL,
  prompt     TEXT NOT NULL,
  answer_key TEXT,
  options    TEXT,
  hints      TEXT,
  section    TEXT,
  passage    TEXT,
  UNIQUE (course_id, qid)
);

CREATE TABLE IF NOT EXISTS quiz_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  workspace  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  answers    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  analysis   TEXT
);

CREATE TABLE IF NOT EXISTS preferences (
  workspace          TEXT PRIMARY KEY,
  selected_course_id INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_course ON questions (course_id, position);
CREATE INDEX IF NOT EXISTS idx_courses_workspace ON courses (workspace, updated_at);
`

/** Default store path (tests can override via DSH_TEACHER_STORE). */
export function questionStoreFilePath() {
  if (process.env.DSH_TEACHER_STORE) return process.env.DSH_TEACHER_STORE
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'state', 'dsh-teacher', 'question-store.db')
}

/** Map a curriculum question object → SQL row values (keys kept). */
function toRow(question, position) {
  return [
    question.qid ?? question.id,
    position,
    question.prompt,
    question.answer ?? question.inlineAnswer ?? null,
    question.options == null ? null : JSON.stringify(question.options),
    Array.isArray(question.hints) ? JSON.stringify(question.hints) : null,
    question.section ?? null,
    question.passage ?? null,
  ]
}

/** Map a SQL row → the in-session curriculum question object shape. */
function fromRow(row, { withKey = true } = {}) {
  const question = {
    id: row.qid,
    number: /^q(\d+)$/.test(row.qid) ? row.qid.slice(1) : null,
    prompt: row.prompt,
    answer: null,
    inlineAnswer: null,
    hints: row.hints ? JSON.parse(row.hints) : [],
    options: row.options ? JSON.parse(row.options) : null,
    section: row.section ?? null,
    passage: row.passage ?? null,
  }
  if (withKey && row.answer_key != null) question.answer = row.answer_key
  return question
}

/** SQLite-backed store (node:sqlite). */
class SqliteQuestionStore {
  constructor(db) {
    this.db = db
  }

  /**
   * Upsert a course GLOBALLY by title: an existing course with the same title
   * is replaced (questions rewritten, id kept, updated bump), otherwise a NEW
   * course is inserted. Other courses are never touched — this is what allows
   * multiple subject courses (English, Science, Math…) to coexist in ONE
   * shared pool that every teacher session sees. The `workspace` column is
   * written as 'global' and no longer scopes anything.
   */
  upsertCourse({ title, source, questions }) {
    const now = Date.now()
    this.db.exec('BEGIN')
    try {
      const existing = this.db.prepare(
        'SELECT id FROM courses WHERE title = ? ORDER BY updated_at DESC LIMIT 1',
      ).get(title)
      let courseId
      if (existing !== undefined) {
        courseId = Number(existing.id)
        this.db.prepare('DELETE FROM questions WHERE course_id = ?').run(courseId)
        this.db.prepare('UPDATE courses SET source = ?, updated_at = ? WHERE id = ?').run(source ?? null, now, courseId)
      } else {
        const inserted = this.db.prepare(
          'INSERT INTO courses (workspace, title, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('global', title, source ?? null, now, now)
        courseId = Number(inserted.lastInsertRowid)
      }
      const insertQ = this.db.prepare(
        'INSERT INTO questions (course_id, qid, position, prompt, answer_key, options, hints, section, passage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      questions.forEach((question, index) => {
        insertQ.run(courseId, ...toRow(question, index))
      })
      this.db.exec('COMMIT')
      return courseId
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** The most recent un-analyzed quiz run across all courses, or null. */
  latestPendingRun() {
    const row = this.db.prepare(
      "SELECT id, workspace FROM quiz_runs WHERE status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1",
    ).get()
    return row === undefined ? null : { runId: Number(row.id), workspace: row.workspace }
  }

  /** All courses in the shared pool, newest first, with question counts. */
  listCourses() {
    return this.db.prepare(`
      SELECT c.id AS courseId, c.title, c.source, c.updated_at AS updatedAt,
             (SELECT COUNT(*) FROM questions q WHERE q.course_id = c.id) AS questionCount
      FROM courses c ORDER BY c.updated_at DESC
    `).all().map((row) => ({
      courseId: Number(row.courseId),
      title: row.title,
      source: row.source ?? null,
      updatedAt: Number(row.updatedAt),
      questionCount: Number(row.questionCount),
    }))
  }

  /** Every course in the store, newest first (used by the popup course picker). */
  listAllCourses() {
    return this.db.prepare(`
      SELECT c.id AS courseId, c.workspace, c.title, c.source, c.updated_at AS updatedAt,
             (SELECT COUNT(*) FROM questions q WHERE q.course_id = c.id) AS questionCount
      FROM courses c ORDER BY c.updated_at DESC
    `).all().map((row) => ({
      courseId: Number(row.courseId),
      workspace: row.workspace,
      title: row.title,
      source: row.source ?? null,
      updatedAt: Number(row.updatedAt),
      questionCount: Number(row.questionCount),
    }))
  }

  /** The globally selected course id (the one the user last chose), or null. */
  getSelectedCourseId() {
    const row = this.db.prepare(
      "SELECT selected_course_id FROM preferences WHERE workspace = 'global'",
    ).get()
    return row === undefined ? null : Number(row.selected_course_id)
  }

  /** Remember the globally selected course id (shared by every session). */
  setSelectedCourseId(courseId) {
    this.db.prepare(
      "INSERT INTO preferences (workspace, selected_course_id) VALUES ('global', ?) ON CONFLICT(workspace) DO UPDATE SET selected_course_id = excluded.selected_course_id",
    ).run(Number(courseId))
  }

  /** The most recently updated course in the shared pool, or null. */
  latestCourse() {
    const course = this.db.prepare(
      'SELECT id, title, source FROM courses ORDER BY updated_at DESC LIMIT 1',
    ).get()
    if (course === undefined) return null
    return this.courseWith(course)
  }

  courseWith(course) {
    const rows = this.db.prepare(
      'SELECT * FROM questions WHERE course_id = ? ORDER BY position ASC',
    ).all(course.id)
    return {
      courseId: Number(course.id),
      title: course.title,
      source: course.source ?? null,
      questions: rows.map((row) => fromRow(row)),
    }
  }

  courseById(courseId) {
    const course = this.db.prepare(
      'SELECT id, workspace, title, source FROM courses WHERE id = ?',
    ).get(Number(courseId))
    if (course === undefined) return null
    return {
      ...this.courseWith(course),
      workspace: course.workspace,
    }
  }

  publicCourse() {
    const course = this.latestCourse()
    if (course === null) return null
    return {
      courseId: course.courseId,
      title: course.title,
      source: course.source,
      questions: course.questions.map((q) => publicQuestion(q)),
    }
  }

  createQuizRun({ workspace, courseId, answers }) {
    const now = Date.now()
    const inserted = this.db.prepare(
      'INSERT INTO quiz_runs (course_id, workspace, created_at, answers, status) VALUES (?, ?, ?, ?, ?)',
    ).run(courseId, workspace, now, JSON.stringify(answers), 'pending')
    return { runId: Number(inserted.lastInsertRowid) }
  }

  getQuizRun(runId) {
    const run = this.db.prepare(
      'SELECT * FROM quiz_runs WHERE id = ?',
    ).get(Number(runId))
    if (run === undefined) return null
    const course = this.db.prepare(
      'SELECT id, title, source FROM courses WHERE id = ?',
    ).get(run.course_id)
    return {
      runId: Number(run.id),
      status: run.status,
      createdAt: run.created_at,
      answers: JSON.parse(run.answers),
      analysis: run.analysis ? JSON.parse(run.analysis) : null,
      course: course === undefined ? null : this.courseWith(course),
    }
  }

  markQuizRunAnalyzed(runId, analysis) {
    this.db.prepare(
      'UPDATE quiz_runs SET status = ?, analysis = ? WHERE id = ?',
    ).run('analyzed', analysis == null ? null : JSON.stringify(analysis), Number(runId))
  }

  close() {
    this.db.close()
  }
}

/** Public (key-free) question shape — safe for events, projections, and wire.
 * Hints are scaffolding, not answers, and are included so the quiz popup can
 * reveal them on demand. */
export function publicQuestion(question) {
  const row = {
    id: question.id,
    prompt: question.prompt,
    hintCount: Array.isArray(question.hints) ? question.hints.length : 0,
  }
  if (Array.isArray(question.options) && question.options.length > 0) row.options = question.options
  if (Array.isArray(question.hints) && question.hints.length > 0) row.hints = question.hints
  if (question.section != null) row.section = question.section
  if (question.passage != null) row.passage = question.passage
  return row
}

/** JSON-file fallback store (mirrors the ledger's fallback). */
class JsonQuestionStore {
  constructor(filePath, data) {
    this.filePath = filePath
    this.data = data
    this.nextId = (data.courses.length + data.quizRuns.length) + 1
  }

  persist() {
    writeFileSync(this.filePath, JSON.stringify(this.data), 'utf8')
  }

  upsertCourse({ title, source, questions }) {
    // Monotonic clock: consecutive writes in the same millisecond must still
    // order by recency (the SQLite store orders by rowid on ties; the JSON
    // store has no such tiebreaker).
    const lastUpdated = this.data.courses.reduce((max, c) => Math.max(max, c.updatedAt), 0)
    const now = Math.max(Date.now(), lastUpdated + 1)
    let course = this.data.courses
      .filter((c) => c.title === title)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    let courseId
    if (course !== undefined) {
      courseId = course.id
      course.source = source ?? null
      course.updatedAt = now
    } else {
      courseId = this.nextId++
      this.data.courses.push({
        id: courseId, workspace: 'global', title, source: source ?? null, createdAt: now, updatedAt: now,
      })
      course = this.data.courses.find((c) => c.id === courseId)
    }
    this.data.questions = this.data.questions.filter((q) => q.course_id !== courseId)
    questions.forEach((question, index) => {
      this.data.questions.push({
        course_id: courseId, ...Object.fromEntries(toRow(question, index).map((v, i) => [
          ['qid', 'position', 'prompt', 'answer_key', 'options', 'hints', 'section', 'passage'][i], v,
        ])),
      })
    })
    this.persist()
    return courseId
  }

  /** All courses in the shared pool, newest first, with question counts. */
  listCourses() {
    return this.data.courses
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({
        courseId: c.id,
        title: c.title,
        source: c.source ?? null,
        updatedAt: c.updatedAt,
        questionCount: this.data.questions.filter((q) => q.course_id === c.id).length,
      }))
  }

  /** The most recent un-analyzed quiz run across all courses, or null. */
  latestPendingRun() {
    const run = this.data.quizRuns
      .filter((r) => r.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    return run === undefined ? null : { runId: run.id, workspace: run.workspace }
  }

  listAllCourses() {
    return this.data.courses
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({
        courseId: c.id,
        workspace: c.workspace,
        title: c.title,
        source: c.source ?? null,
        updatedAt: c.updatedAt,
        questionCount: this.data.questions.filter((q) => q.course_id === c.id).length,
      }))
  }

  getSelectedCourseId() {
    const pref = this.data.preferences?.find((p) => p.workspace === 'global')
    return pref === undefined ? null : pref.selected_course_id
  }

  setSelectedCourseId(courseId) {
    this.data.preferences = this.data.preferences ?? []
    const pref = this.data.preferences.find((p) => p.workspace === 'global')
    if (pref === undefined) this.data.preferences.push({ workspace: 'global', selected_course_id: Number(courseId) })
    else pref.selected_course_id = Number(courseId)
    this.persist()
  }

  /** The most recently updated course in the shared pool, or null. */
  latestCourse() {
    const course = this.data.courses
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (course === undefined) return null
    return this.courseWith(course)
  }

  courseWith(course) {
    const rows = this.data.questions
      .filter((q) => q.course_id === course.id)
      .sort((a, b) => a.position - b.position)
    return {
      courseId: course.id,
      title: course.title,
      source: course.source ?? null,
      questions: rows.map((row) => ({
        id: row.qid,
        number: /^q(\d+)$/.test(row.qid) ? row.qid.slice(1) : null,
        prompt: row.prompt,
        answer: row.answer_key ?? null,
        inlineAnswer: null,
        hints: row.hints ? JSON.parse(row.hints) : [],
        options: row.options ? JSON.parse(row.options) : null,
        section: row.section ?? null,
        passage: row.passage ?? null,
      })),
    }
  }

  courseById(courseId) {
    const course = this.data.courses.find((c) => c.id === Number(courseId))
    if (course === undefined) return null
    return {
      ...this.courseWith(course),
      workspace: course.workspace,
    }
  }

  publicCourse() {
    const course = this.latestCourse()
    if (course === null) return null
    return {
      courseId: course.courseId,
      title: course.title,
      source: course.source,
      questions: course.questions.map((q) => publicQuestion(q)),
    }
  }

  createQuizRun({ workspace, courseId, answers }) {
    const runId = this.nextId++
    // Monotonic clock (same-millisecond writes must still order by recency).
    const lastRunAt = this.data.quizRuns.reduce((max, r) => Math.max(max, r.createdAt), 0)
    this.data.quizRuns.push({
      id: runId, course_id: courseId, workspace, createdAt: Math.max(Date.now(), lastRunAt + 1),
      answers: JSON.stringify(answers), status: 'pending', analysis: null,
    })
    this.persist()
    return { runId }
  }

  getQuizRun(runId) {
    const run = this.data.quizRuns.find((r) => r.id === runId)
    if (run === undefined) return null
    const course = this.data.courses.find((c) => c.id === run.course_id)
    return {
      runId: run.id,
      status: run.status,
      createdAt: run.createdAt,
      answers: JSON.parse(run.answers),
      analysis: run.analysis ? JSON.parse(run.analysis) : null,
      course: course === undefined ? null : this.courseWith(course),
    }
  }

  markQuizRunAnalyzed(runId, analysis) {
    const run = this.data.quizRuns.find((r) => r.id === runId)
    if (run === undefined) return
    run.status = 'analyzed'
    run.analysis = analysis == null ? null : JSON.stringify(analysis)
    this.persist()
  }

  close() {}
}

export class QuestionStore {
  /**
   * Open a store at `filePath`. A `.db` path uses node:sqlite when available
   * and falls back to a sibling `.json` file otherwise; a `.json` path always
   * uses the JSON store.
   * @returns {Promise<{ store: object, kind: 'sqlite'|'json' }>}
   */
  static async open(filePath) {
    mkdirSync(dirname(filePath), { recursive: true })
    if (filePath.endsWith('.json')) {
      let data = { courses: [], questions: [], quizRuns: [], preferences: [] }
      try {
        data = JSON.parse(readFileSync(filePath, 'utf8'))
      } catch {
        /* first run */
      }
      return { store: new JsonQuestionStore(filePath, data), kind: 'json' }
    }
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(filePath)
      db.exec(SQL_SCHEMA)
      return { store: new SqliteQuestionStore(db), kind: 'sqlite' }
    } catch (error) {
      return QuestionStore.open(filePath.replace(/\.db$/, '.json'))
    }
  }
}
