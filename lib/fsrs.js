/**
 * Compact FSRS-5 spaced-repetition scheduler.
 *
 * Faithful port of the published FSRS-5 algorithm (19 weights) as implemented
 * by open-spaced-repetition/ts-fsrs (MIT), restricted to the behavior dsh-teacher
 * needs: one `review(card, rating, now)` step returning the next card with a
 * `scheduled_days` interval. Fuzzing is disabled (deterministic intervals);
 * the unit tests pin the exact official interval history vector.
 *
 * @see https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm
 * @see https://github.com/open-spaced-repetition/ts-fsrs
 */

export const DAY_MS = 86_400_000
export const S_MIN = 0.001
export const S_MAX = 36_500

/** FSRS-5 default parameters (19 weights). */
export const FSRS5_W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
  0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655,
  0.6621,
]

export const Rating = Object.freeze({ Again: 1, Hard: 2, Good: 3, Easy: 4 })
export const State = Object.freeze({
  New: 0,
  Learning: 1,
  Review: 2,
  Relearning: 3,
})
export const STATE_NAME = ['new', 'learning', 'review', 'relearning']

function roundTo(x, n = 8) {
  const p = 10 ** n
  return Math.round(x * p) / p
}

function clamp(x, lo, hi) {
  return Math.min(Math.max(x, lo), hi)
}

export class FSRS {
  constructor({
    w = FSRS5_W,
    requestRetention = 0.9,
    maximumInterval = S_MAX,
    enableFuzz = false,
    enableShortTerm = true,
    learningSteps = [1, 10], // minutes
    relearningSteps = [10], // minutes
  } = {}) {
    // 19-weight FSRS-5 input is padded to the 21-slot layout used here:
    // w[19] (same-day decay power) = 0, w[20] (forgetting-curve decay) = 0.5.
    this.w = w.length === 19 ? [...w, 0, 0.5] : [...w]
    this.requestRetention = requestRetention
    this.maximumInterval = maximumInterval
    this.enableFuzz = enableFuzz
    this.enableShortTerm = enableShortTerm
    this.learningSteps = learningSteps
    this.relearningSteps = relearningSteps
    const decay = -this.w[20]
    this.decay = decay
    this.factor = roundTo(Math.exp((1 / decay) * Math.log(0.9)) - 1, 8)
    this.intervalModifier = roundTo(
      (requestRetention ** (1 / decay) - 1) / this.factor,
      8,
    )
  }

  /** R(t, S) — retrievability after t days. */
  forgettingCurve(t, stability) {
    return roundTo(
      (1 + (this.factor * t) / stability) ** this.decay,
      8,
    )
  }

  initStability(g) {
    return Math.max(this.w[g - 1], 0.1)
  }

  initDifficulty(g) {
    const d = this.w[4] - Math.exp((g - 1) * this.w[5]) + 1
    return roundTo(d, 8)
  }

  nextDifficulty(d, g) {
    const deltaD = -this.w[6] * (g - 3)
    const nextD = d + (deltaD * (10 - d)) / 9
    const d0Easy = this.initDifficulty(Rating.Easy)
    return clamp(this.w[7] * d0Easy + (1 - this.w[7]) * nextD, 1, 10)
  }

  nextRecallStability(d, s, r, g) {
    const hardPenalty = g === Rating.Hard ? this.w[15] : 1
    const easyBound = g === Rating.Easy ? this.w[16] : 1
    return roundTo(
      clamp(
        s *
          (1 +
            Math.exp(this.w[8]) *
              (11 - d) *
              s ** -this.w[9] *
              (Math.exp((1 - r) * this.w[10]) - 1) *
              hardPenalty *
              easyBound),
        S_MIN,
        S_MAX,
      ),
      8,
    )
  }

  nextForgetStability(d, s, r) {
    return roundTo(
      clamp(
        this.w[11] *
          d ** -this.w[12] *
          ((s + 1) ** this.w[13] - 1) *
          Math.exp((1 - r) * this.w[14]),
        S_MIN,
        S_MAX,
      ),
      8,
    )
  }

  nextShortTermStability(s, g) {
    const sinc = s ** -this.w[19] * Math.exp(this.w[17] * (g - 3 + this.w[18]))
    const masked = g >= Rating.Hard ? Math.max(sinc, 1) : sinc
    return roundTo(clamp(s * masked, S_MIN, S_MAX), 8)
  }

  /**
   * Next memory state after elapsed t days with grade g.
   * r (retrievability) is computed when omitted.
   */
  nextState({ difficulty: d, stability: s }, t, g, r) {
    if (d === 0 && s === 0) {
      return {
        difficulty: clamp(this.initDifficulty(g), 1, 10),
        stability: this.initStability(g),
      }
    }
    const rv = r === undefined ? this.forgettingCurve(t, s) : r
    let newS
    if (t === 0 && this.enableShortTerm) {
      newS = this.nextShortTermStability(s, g)
    } else if (g === Rating.Again) {
      const sAfterFail = this.nextForgetStability(d, s, rv)
      const w17 = this.enableShortTerm ? this.w[17] : 0
      const w18 = this.enableShortTerm ? this.w[18] : 0
      const nextSMin = s / Math.exp(w17 * w18)
      newS = clamp(roundTo(nextSMin, 8), S_MIN, sAfterFail)
    } else {
      newS = this.nextRecallStability(d, s, rv, g)
    }
    return { difficulty: this.nextDifficulty(d, g), stability: newS }
  }

  nextInterval(s, elapsedDays) {
    return Math.min(
      Math.max(1, Math.round(s * this.intervalModifier)),
      this.maximumInterval,
    )
  }
}

/** A fresh card due now. */
export function createCard(now = Date.now()) {
  return {
    due: now,
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: State.New,
    lastReview: null,
    learningStep: 0,
  }
}

/**
 * Learning-step strategy mirroring ts-fsrs BasicLearningStepsStrategy.
 * Returns { scheduledMinutes, nextStep } for the given card state/step and
 * grade; `null` for the grade when it should graduate instead.
 */
function learningStepInfo(fsrs, state, curStep, grade) {
  const steps =
    state === State.Relearning || state === State.Review
      ? fsrs.relearningSteps
      : fsrs.learningSteps
  const len = steps.length
  if (len === 0 || curStep >= len) return null
  const first = steps[0]
  const next = steps[curStep + 1]
  if (grade === Rating.Again) {
    return { scheduledMinutes: first, nextStep: 0 }
  }
  if (state === State.Review) {
    // Review state only gets an Again entry; handled by caller.
    return null
  }
  if (grade === Rating.Hard) {
    const m = len === 1 ? first * 1.5 : (first + steps[1]) / 2
    return { scheduledMinutes: Math.round(m), nextStep: curStep }
  }
  if (grade === Rating.Good && next !== undefined) {
    return { scheduledMinutes: next, nextStep: curStep + 1 }
  }
  return null // Good beyond the last learning step → graduate
}

/**
 * Apply learning steps to the candidate next card. When the grade has no step
 * (graduate), the card moves to Review with a scheduled interval.
 */
function applyLearningSteps(fsrs, next, grade, state, toState, elapsedDays, now) {
  const info = learningStepInfo(fsrs, state, next.learningStep, grade)
  if (info !== null && info.scheduledMinutes > 0 && info.scheduledMinutes < 1440) {
    next.learningStep = info.nextStep
    next.scheduledDays = 0
    next.state = toState
    next.due = now + Math.round(info.scheduledMinutes) * 60_000
    return
  }
  if (info !== null && info.scheduledMinutes >= 1440) {
    next.learningStep = info.nextStep
    next.scheduledDays = Math.floor(info.scheduledMinutes / 1440)
    next.state = State.Review
    next.due = now + next.scheduledDays * DAY_MS
    return
  }
  // Graduate.
  next.learningStep = 0
  next.state = State.Review
  const interval = fsrs.nextInterval(next.stability, elapsedDays)
  next.scheduledDays = interval
  next.due = now + interval * DAY_MS
}

/**
 * Review a card with the given rating at `now`.
 * @returns the next card (plain object) plus the review log.
 */
export function review(fsrs, card, grade, now = Date.now()) {
  const elapsedDays =
    card.state === State.New ? 0 : Math.floor((now - card.lastReview) / DAY_MS)
  const next = { ...card, lastReview: now, elapsedDays, reps: card.reps + 1 }
  const current = card

  if (current.state === State.New) {
    const ms = fsrs.nextState({ difficulty: 0, stability: 0 }, 0, grade)
    next.stability = ms.stability
    next.difficulty = ms.difficulty
    applyLearningSteps(fsrs, next, grade, State.New, State.Learning, 0, now)
  } else if (current.state === State.Learning || current.state === State.Relearning) {
    const ms = fsrs.nextState(
      { difficulty: current.difficulty, stability: current.stability },
      elapsedDays,
      grade,
    )
    next.stability = ms.stability
    next.difficulty = ms.difficulty
    applyLearningSteps(
      fsrs, next, grade, current.state, current.state, elapsedDays, now,
    )
  } else {
    // Review state.
    const r = fsrs.forgettingCurve(elapsedDays, current.stability)
    const again = fsrs.nextState(
      { difficulty: current.difficulty, stability: current.stability },
      elapsedDays, Rating.Again, r,
    )
    const hard = fsrs.nextState(
      { difficulty: current.difficulty, stability: current.stability },
      elapsedDays, Rating.Hard, r,
    )
    const good = fsrs.nextState(
      { difficulty: current.difficulty, stability: current.stability },
      elapsedDays, Rating.Good, r,
    )
    const easy = fsrs.nextState(
      { difficulty: current.difficulty, stability: current.stability },
      elapsedDays, Rating.Easy, r,
    )
    if (grade === Rating.Again) {
      next.stability = again.stability
      next.difficulty = again.difficulty
      next.lapses += 1
      applyLearningSteps(fsrs, next, Rating.Again, State.Review, State.Relearning, elapsedDays, now)
    } else {
      const ms = grade === Rating.Hard ? hard : grade === Rating.Good ? good : easy
      next.stability = ms.stability
      next.difficulty = ms.difficulty
      next.state = State.Review
      next.learningStep = 0
      const interval = fsrs.nextInterval(ms.stability, elapsedDays)
      next.scheduledDays = interval
      next.due = now + interval * DAY_MS
    }
  }

  return { card: next }
}

/** One step of the schedule as a plain ledger-friendly summary. */
export function scheduleSummary(card, rating) {
  return {
    rating,
    state: STATE_NAME[card.state],
    stability: card.stability,
    difficulty: card.difficulty,
    scheduledDays: card.scheduledDays,
    dueAt: card.due,
    lapses: card.lapses,
    reps: card.reps,
  }
}
