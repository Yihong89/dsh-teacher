/**
 * `teacherQuiz` session projection: folds `teacher/course` (public questions —
 * never answer keys), `teacher/quiz` (popup/quick-test mode), and
 * `teacher/quiz-run` (analysis status) events so the Web client can render the
 * LLM-free quiz popup through `useProjection('teacherQuiz')` (same pattern as
 * `teacherGaps`).
 *
 * The quiz itself is LLM-free: questions come from this projection, and the
 * user's answers are submitted to the host via `POST /dsh-teacher/quiz/submit`
 * (stored in the SQLite question store); the LLM analysis happens afterwards
 * through the `analyze_quiz` model tool.
 */

export const TEACHER_QUIZ_KEY = 'teacherQuiz'

export function initQuizProjection() {
  return { course: null, quizActive: false, lastRun: null }
}

/**
 * Fold one committed session event. Must return the SAME reference when the
 * event is not the unit's (the projection registry's zero-work contract).
 */
export function applyQuizProjection(state, event) {
  if (event.type === 'teacher/course') {
    const questions = Array.isArray(event.data.questions) ? event.data.questions : []
    return {
      course: {
        courseId: event.data.courseId ?? null,
        title: event.data.title ?? null,
        source: event.data.source ?? null,
        questions,
      },
      quizActive: state.quizActive,
      lastRun: state.lastRun,
    }
  }
  if (event.type === 'teacher/quiz') {
    return {
      course: state.course,
      quizActive: Boolean(event.data.active),
      lastRun: state.lastRun,
    }
  }
  if (event.type === 'teacher/quiz-run') {
    return {
      course: state.course,
      quizActive: state.quizActive,
      lastRun: {
        runId: event.data.runId,
        status: event.data.status,
      },
    }
  }
  return state
}

/** State → wire payload (read-side projection; schema-validated by the host). */
export function viewQuizProjection(state) {
  return state
}

/** Bind the fold to a schema and return a ProjectionDefinition. */
export function quizProjectionWith(schema) {
  return {
    key: TEACHER_QUIZ_KEY,
    schema,
    init: initQuizProjection,
    apply: applyQuizProjection,
    view: viewQuizProjection,
    stateVersion: 1,
  }
}
