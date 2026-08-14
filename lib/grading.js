/**
 * Grading helpers: map a model's answer verdict to a gap kind and an FSRS
 * rating. Content grading itself is model-judged against the hidden answer
 * key; these helpers keep the verdict → ledger/FSRS mapping deterministic.
 */
import { Rating } from './fsrs.js'

export const VERDICTS = Object.freeze({
  correct: 'correct',
  partial: 'partial',
  wrong: 'wrong',
  'no-answer': 'no-answer',
})

export const GAP_KINDS = Object.freeze({
  wrong: 'wrong',
  vague: 'vague',
  missing: 'missing',
  exposed: 'exposed',
})

/** Gap kind recorded for a non-correct verdict (exposed is set explicitly). */
export function gapKindForVerdict(verdict) {
  switch (verdict) {
    case VERDICTS.partial:
      return GAP_KINDS.vague
    case VERDICTS.wrong:
      return GAP_KINDS.wrong
    case VERDICTS['no-answer']:
      return GAP_KINDS.missing
    default:
      return null
  }
}

/** FSRS rating implied by a verdict when grading a gap. */
export function ratingForVerdict(verdict) {
  switch (verdict) {
    case VERDICTS.correct:
      return Rating.Good
    case VERDICTS.partial:
      return Rating.Hard
    default:
      return Rating.Again
  }
}

/** Whether the verdict counts as resolved (no gap remains). */
export function isCorrect(verdict) {
  return verdict === VERDICTS.correct
}

/** Short user-facing label for a verdict. */
export function verdictLabel(verdict) {
  return {
    correct: 'correct',
    partial: 'partially correct',
    wrong: 'wrong',
    'no-answer': 'no answer given',
  }[verdict] ?? verdict
}

/**
 * Build a gap record (without id/timestamps — the ledger adds those).
 * @param {object} input { questionId, topic, userQuote, kind, confidence }
 */
export function buildGap(input) {
  return {
    questionId: input.questionId,
    topic: (input.topic || '').trim(),
    kind: input.kind,
    evidence: (input.userQuote || '').trim(),
    confidence:
      input.confidence === undefined
        ? null
        : Math.min(5, Math.max(1, Number(input.confidence) || 1)),
  }
}

/** Validate a kind string against the known set. */
export function isGapKind(kind) {
  return Object.values(GAP_KINDS).includes(kind)
}
