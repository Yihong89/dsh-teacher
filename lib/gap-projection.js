/**
 * `teacherGaps` session projection: a pure fold over `teacher/gap` and
 * `teacher/grade` events so the Web client can render the in-session gap
 * ledger through the slot `useProjection('teacherGaps')` hook (the same
 * pattern dsh-usage-plugin uses for `usageReport`).
 *
 * The projection carries only what the current session logged; the durable
 * cross-session ledger stays in SQLite and is surfaced by /gaps and /retest.
 */

export const TEACHER_GAPS_KEY = 'teacherGaps'

export function initGapProjection() {
  return { gaps: [], grades: [] }
}

/**
 * Fold one committed session event. Must return the SAME reference when the
 * event is not the unit's (the projection registry's zero-work contract).
 */
export function applyGapProjection(state, event) {
  if (event.type === 'teacher/gap') {
    return { gaps: [...state.gaps, event.data.gap], grades: state.grades }
  }
  if (event.type === 'teacher/grade') {
    return {
      gaps: state.gaps,
      grades: [
        ...state.grades,
        {
          questionId: event.data.questionId,
          verdict: event.data.verdict,
          at: event.time,
        },
      ],
    }
  }
  return state
}

/** State → wire payload (read-side projection; schema-validated by the host). */
export function viewGapProjection(state) {
  return { gaps: state.gaps, grades: state.grades }
}

/** Bind the fold to a schema and return a ProjectionDefinition. */
export function gapProjectionWith(schema) {
  return {
    key: TEACHER_GAPS_KEY,
    schema,
    init: initGapProjection,
    apply: applyGapProjection,
    view: viewGapProjection,
    stateVersion: 1,
  }
}
