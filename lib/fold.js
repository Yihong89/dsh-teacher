/**
 * Session-event folding for dsh-teacher.
 *
 * Teacher mode and gaps are log-only session state, so resume/fork/compaction
 * recover them without a live mirror (same pattern as dsh-learn-everything's
 * `learning/mode`):
 *
 * - `teacher/mode`     { active: boolean, course: string|null }  — last one wins
 * - `teacher/quiz`     { active: boolean }                       — popup quiz mode
 * - `teacher/course`   { title, source, questions }              — public questions
 * - `teacher/quiz-run` { runId, status }                         — analysis progress
 * - `teacher/speak`    { enabled: boolean }                      — TTS toggle
 * - `teacher/spoken`   { text, voice }                           — a speak request
 * - `teacher/gap`      { gap }                                   — appended per gap
 * - `teacher/grade`    { questionId, verdict, rating }           — review history
 */

export const MODE_EVENT = 'teacher/mode'
export const GAP_EVENT = 'teacher/gap'
export const GRADE_EVENT = 'teacher/grade'
export const QUIZ_EVENT = 'teacher/quiz'
export const COURSE_EVENT = 'teacher/course'
export const QUIZ_RUN_EVENT = 'teacher/quiz-run'
export const SPEAK_EVENT = 'teacher/speak'
export const SPOKEN_EVENT = 'teacher/spoken'

/**
 * Fold teacher state from a session log (or a prefix of it).
 * @returns {{ active: boolean, course: string|null, quiz: boolean, speakEnabled: boolean, lastCourse: object|null, lastRun: object|null, lastSpoken: object|null, gaps: Array }}
 */
export function foldTeacherState(events, end = events.length) {
  let active = false
  let course = null
  let quiz = false
  let speakEnabled = true
  let lastCourse = null
  let lastRun = null
  let lastSpoken = null
  const gaps = []
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    if (event.type === MODE_EVENT) {
      active = Boolean(event.data.active)
      course = event.data.course ?? null
    } else if (event.type === QUIZ_EVENT) {
      quiz = Boolean(event.data.active)
    } else if (event.type === SPEAK_EVENT) {
      speakEnabled = Boolean(event.data.enabled)
    } else if (event.type === SPOKEN_EVENT) {
      lastSpoken = {
        text: event.data.text ?? '',
        voice: event.data.voice ?? null,
        seq: event.time ?? index,
      }
    } else if (event.type === COURSE_EVENT) {
      lastCourse = {
        title: event.data.title ?? null,
        source: event.data.source ?? null,
        questions: Array.isArray(event.data.questions) ? event.data.questions : [],
      }
    } else if (event.type === QUIZ_RUN_EVENT) {
      lastRun = { runId: event.data.runId, status: event.data.status }
    } else if (event.type === GAP_EVENT) {
      gaps.push(event.data.gap)
    }
  }
  return { active, course, quiz, speakEnabled, lastCourse, lastRun, lastSpoken, gaps }
}

/** Whether teacher mode is in force at the last logged request header. */
export function teacherModeAtLastHeader(events) {
  let lastHeader = -1
  let index = 0
  for (const event of events) {
    if (event.type === 'request/header') lastHeader = index
    index++
  }
  if (lastHeader < 0) return false
  return foldTeacherState(events, lastHeader + 1).active
}

/** The most recent teacher/gap records (newest last), optionally limited. */
export function recentGaps(events, limit = Infinity) {
  const gaps = foldTeacherState(events).gaps
  return limit === Infinity ? gaps : gaps.slice(-limit)
}

/** Whether the log holds an opened turn without its closing `turn/end`. */
export function hasOpenTurn(events) {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}
