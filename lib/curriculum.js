/**
 * Tolerant markdown curriculum parser.
 *
 * Real question notebooks do not follow one strict pattern, so this parser is
 * signal-based rather than format-based: it walks lines, recognizes whichever
 * question/answer/hint signals appear, and keeps only items that actually
 * carry question signals (an answer, options, or hints). Everything is
 * supported in any combination, in one pass:
 *
 * Questions — numbered items, Q-prefixed items, or `## Q<n>:` headings:
 *   `1. prompt`, `1) prompt`, `1、prompt`, `Q1. prompt`, `**1.** prompt`,
 *   `## Q1: prompt` (heading)
 *
 * Answers — comment, line, inline arrow, or MC marker:
 *   `<!-- answer: X -->`, `→ **Answer:** X`, `**Answer:** X`, `Answer: X`,
 *   `答案：X`, `Correct answer: X`, `1. prompt → X` (inline arrow),
 *   ✅-marked option (see options)
 *
 * Hints — comment or labeled line/blockquote (Chinese or English labels):
 *   `<!-- hint 1: X -->`, `> **Key words:** X`, `> **Trap:** X`,
 *   `> 关键词：X`, `> 陷阱：X`, `> Clue: X`, `> 提示：X`; a `>` blockquote
 *   right after a hint is appended as its continuation.
 *
 * Multiple-choice options — single-line or one per line:
 *   `A. x &emsp; B. y ✅ D. z`, `A) x`, `A、x`, `A. x` / `B. y` on separate
 *   lines; correct-option signals: ✅ ☑ ✓ ✔, a trailing `(correct)`/`(对)`,
 *   or — when no marker exists anywhere — the single bolded option (Anki
 *   convention).
 *
 * Sections: `# Title` → course title, `## Section` → section, `### Passage`
 * → passage (attached to each question). Numbering may restart per passage;
 * ids stay unique (`q1`, or `passage-slug-1` on collision).
 *
 * Items that end with no answer, options, or hints are treated as prose /
 * grammar-guide steps and dropped. Answer keys are never exposed through
 * `publicQuestions()`.
 */

/** Strip HTML comments from a markdown string. */
export function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

/** Whether the document looks like a question collection (vs. plan grammar). */
export function isCollectionFormat(text) {
  return /→\s*\*\*Answer\b/i.test(text) || /✅|☑/.test(text)
}

function parseFrontmatter(lines) {
  const meta = {}
  if (lines.length >= 2 && lines[0].trim() === '---') {
    let i = 1
    while (i < lines.length && lines[i].trim() !== '---') {
      const m = lines[i].match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
      if (m) meta[m[1].trim()] = m[2].trim()
      i++
    }
  }
  return meta
}

function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'q'
  )
}

function ensureUnique(questions, id) {
  const seen = new Set(questions.map((q) => q.id))
  if (!seen.has(id)) return id
  let base = id
  let n = 2
  let candidate = `${base}-${n}`
  while (seen.has(candidate)) candidate = `${base}-${n++}`
  return candidate
}

/** Normalize blank markers (`**\_**`, `\_\_`) to `____` in a prompt. */
function normalizeBlanks(text) {
  return text
    .replace(/\*\*\\?_+\*\*/g, '____')
    .replace(/\\?_{2,}/g, '____')
}

const Q_HEADING = /^#{1,6}\s+(?:Q\s*)([\d.]+)\s*[:：]\s*(.+)$/i
const ITEM_BOLD = /^\s*\*{1,2}\s*(Q\s*)?(\d+)\s*[.)、:：]\s*\*{1,2}\s*(.+)$/
const ITEM_PLAIN = /^\s*(Q\s*)?(\d+)\s*[.)、:：]\s+(.+)$/

/** Match a numbered item line → { id, prompt } or null. */
function matchItem(line) {
  const bold = line.match(ITEM_BOLD)
  if (bold) return { id: `q${bold[2]}`, prompt: bold[3].trim() }
  const plain = line.match(ITEM_PLAIN)
  if (plain) return { id: `q${plain[2]}`, prompt: plain[3].trim() }
  return null
}

/** Match an answer-signal line → answer text or null. */
function answerFromLine(line) {
  const bold = line.match(
    /^[→➡\-]?\s*\*\*?(?:Answer|Correct\s+answer|答案|正确答案)\s*[:：]\*\*\s*([\s\S]*?)(?:\*\*)?\s*$/i,
  )
  if (bold) return bold[1].trim() || null
  const plain = line.match(
    /^[→➡\-]?\s*(?:Answer|Correct\s+answer|答案|正确答案)\s*[:：]\s*(.+)$/i,
  )
  if (plain) return plain[1].trim()
  return null
}

const HINT_SKIP = /选项分析|答案分析|Answer\s+analysis/i

/** Match a hint-signal line → hint text or null. */
function hintFromLine(line) {
  if (HINT_SKIP.test(line)) return null
  const labels = 'Key\\s*words?|关键词|Trap|陷阱|Clue|线索|Hint|提示'
  const bold = line.match(
    new RegExp(`^(?:>\\s*)?\\*\\*?(?:${labels})\\s*[:：]\\*\\*\\s*([\\s\\S]*?)(?:\\*\\*)?\\s*$`, 'i'),
  )
  if (bold) return bold[1].trim() || null
  const plain = line.match(
    new RegExp(`^(?:>\\s*)?(?:${labels})\\s*[:：]\\s*(.+)$`, 'i'),
  )
  if (plain) return plain[1].trim()
  return null
}

const CORRECT_MARKS = /[✅☑✓✔]/
const OPTION_SINGLE = /^(?:\*\*)?([A-Ha-h])[.)、]\s*(.+)$/
const OPTION_SEGMENT = /^(\*\*)?✅?\s*([A-Ha-h])[.)、]\s*(.+)$/

/**
 * Parse a single-line options row (`A. x &emsp; B. y ...`) →
 * { options, flagged } or null.
 */
function parseInlineOptions(line) {
  if (!OPTION_SINGLE.test(line.trim()) && !CORRECT_MARKS.test(line)) return null
  const segments = line.split(/&emsp;|&nbsp;|\s{3,}|\|/)
  const options = []
  const flagged = []
  for (const seg of segments) {
    const m = seg.trim().match(OPTION_SEGMENT)
    if (!m) continue
    let text = m[3].trim().replace(/\*\*/g, '')
    const marked = CORRECT_MARKS.test(seg) || /\(correct\)|（对）|\(对\)/i.test(seg)
    text = text.replace(CORRECT_MARKS, '').replace(/\(correct\)|（对）|\(对\)/i, '').trim()
    options.push(text)
    if (marked) flagged.push(text)
  }
  if (options.length === 0) return null
  return { options, flagged }
}

/** Extract a question's parenthesized prompt-blank: `... **(see)** ...` → null, kept verbatim. */

/**
 * Parse the document.
 * @param {string} text raw markdown
 * @returns {{ title, lang, questions: Array<{id, number?, prompt, answer, hints, options?, section?, passage?}> }}
 */
export function parseCurriculum(text) {
  const lines = text.split(/\r?\n/)
  const meta = parseFrontmatter(lines)
  const collection = isCollectionFormat(text)
  const questions = []
  let title = meta.title ?? null
  const lang = meta.lang ?? null
  let section = null
  let passage = null
  let current = null
  let inHints = false // plan-grammar `### hints` block
  let hintTail = false // blockquote continuation after a hint
  let pendingOptions = null // consecutive single option lines
  let optionStreak = 0

  const finalize = () => {
    if (current !== null) {
      if (pendingOptions !== null && pendingOptions.options.length >= 2) {
        current.options = pendingOptions.options
        if (pendingOptions.correct !== null) current.answer = current.answer ?? pendingOptions.correct
      }
      // In collection mode a numbered item is a question only when it carries
      // an answer, options, or hints (bare grammar-guide steps are dropped).
      // In plan grammar every `## …` heading is an explicit question.
      const hasSignals =
        !collection ||
        current.answer !== null ||
        (current.options ?? []).length > 0 ||
        current.hints.length > 0
      if (hasSignals) {
        current.id = ensureUnique(questions, current.id || slugify(current.prompt))
        questions.push(current)
      }
      current = null
    }
    pendingOptions = null
    optionStreak = 0
    inHints = false
    hintTail = false
  }

  const beginQuestion = (id, prompt, inlineAnswer = null) => {
    const number =
      typeof id === 'string' && id.startsWith('q') ? id.slice(1) : null
    let finalId = id
    if (number !== null && questions.some((q) => q.id === id)) {
      finalId = `${slugify(passage || section || 'q')}-${number}`
    }
    current = {
      id: finalId,
      number,
      prompt: normalizeBlanks(prompt),
      answer: null,
      inlineAnswer,
      hints: [],
      options: null,
      section,
      passage,
    }
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    // HTML comments: answer / hint / options keys (any mode).
    const cAnswer = line.match(/^<!--\s*answer\s*[:：]\s*([\s\S]*?)-->\s*$/)
    if (cAnswer) {
      if (current !== null) {
        current.answer = cAnswer[1].trim() || null
        inHints = false
        hintTail = false
      }
      continue
    }
    const cOptions = line.match(/^<!--\s*options\s*[:：]\s*([\s\S]*?)-->\s*$/)
    if (cOptions) {
      if (current !== null) {
        const raw = cOptions[1].trim()
        current.options = raw
          .split(/[|;]|\n|&emsp;/)
          .map((s) => s.replace(/^[A-Ha-h][.)、]\s*/, '').trim())
          .filter(Boolean)
      }
      continue
    }
    const cHint = line.match(/^<!--\s*hint\s*\d*\s*[:：]\s*([\s\S]*?)-->\s*$/)
    if (cHint) {
      if (current !== null && cHint[1].trim()) current.hints.push(cHint[1].trim())
      continue
    }
    if (inHints && current !== null) {
      const m = line.match(/^<!--\s*(.+?)-->\s*$/)
      if (m && m[1].trim()) {
        current.hints.push(m[1].trim())
        continue
      }
    }

    // Headings.
    if (/^#{1,6}\s/.test(line)) {
      const qHeading = line.match(Q_HEADING)
      if (qHeading) {
        finalize()
        beginQuestion(`q${qHeading[1]}`, qHeading[2])
        inHints = false
        continue
      }
      const h1 = line.match(/^#\s+(.+)$/)
      const h2 = line.match(/^##\s+(.+)$/)
      const h3 = line.match(/^###\s+(.+)$/)
      if (h1) {
        // Frontmatter title wins; otherwise the first H1 names the course.
        if (title === null) title = h1[1].trim()
      } else if (h2) {
        finalize()
        if (collection) {
          section = h2[1].trim()
          passage = null
        } else {
          beginQuestion(null, h2[1].trim())
        }
      } else if (h3) {
        // A `### hints` block belongs to the current question — no finalize.
        if (/^###\s+hints?$/i.test(line)) {
          inHints = true
        } else {
          finalize()
          if (collection) passage = h3[1].trim()
        }
      }
      continue
    }

    // Numbered item → question.
    const item = matchItem(line)
    if (item !== null) {
      finalize()
      let prompt = item.prompt
      let inlineAnswer = null
      const arrow = prompt.match(/^(.+?)\s*[→➡]\s*(.+)$/)
      if (arrow) {
        prompt = arrow[1].trim()
        inlineAnswer = arrow[2].trim()
      }
      beginQuestion(item.id, prompt, inlineAnswer)
      continue
    }
    if (current === null) continue

    // Answer-signal line.
    const answer = answerFromLine(line)
    if (answer !== null) {
      current.answer = answer
      hintTail = false
      continue
    }

    // Hint-signal line / continuation.
    const hint = hintFromLine(line)
    if (hint !== null) {
      if (current.hints.length === 0 || hintTail || /^>/.test(line)) current.hints.push(hint)
      hintTail = /^>/.test(line)
      continue
    }
    if (hintTail && /^>/.test(line)) {
      const tail = line.replace(/^>\s*/, '').trim()
      if (tail) {
        current.hints[current.hints.length - 1] += ` ${tail}`
        continue
      }
    }

    // Multiple-choice options.
    if (pendingOptions === null && /^>\s*-/.test(line)) continue // analysis blockquote
    const inline = parseInlineOptions(line)
    if (inline !== null && inline.options.length >= 2) {
      pendingOptions = null
      optionStreak = 0
      current.options = inline.options
      if (inline.flagged.length > 0) current.answer = current.answer ?? inline.flagged[0]
      else if (!CORRECT_MARKS.test(line)) {
        // No marker anywhere: single bolded option = correct (Anki style).
        const bold = inline.options.filter((_, i) => /\*\*/.test(line.split(/&emsp;|&nbsp;|\s{3,}|\|/)[i] ?? ''))
        if (bold.length === 1) current.answer = current.answer ?? bold[0]
      }
      continue
    }
    const single = line.match(OPTION_SINGLE)
    if (single !== null) {
      const letter = single[1]
      let text = single[2].trim().replace(/\*\*/g, '')
      const marked = CORRECT_MARKS.test(line) || /\(correct\)|（对）|\(对\)/i.test(line)
      text = text.replace(CORRECT_MARKS, '').replace(/\(correct\)|（对）|\(对\)/i, '').trim()
      if (pendingOptions === null) pendingOptions = { options: [], correct: null, hasMarks: false }
      pendingOptions.options.push(text)
      pendingOptions.hasMarks = pendingOptions.hasMarks || CORRECT_MARKS.test(line)
      if (marked) pendingOptions.correct = text
      optionStreak++
      continue
    }
    // Anything else ends an option streak and is ignored.
    if (pendingOptions !== null && optionStreak > 0) {
      if (optionStreak === 1 && pendingOptions.correct === null && !pendingOptions.hasMarks) {
        pendingOptions = null // single stray letter line — not options
      }
      optionStreak = 0
    }
    hintTail = false
  }
  finalize()
  return { title, lang, questions }
}

/** Questions as the model may see them: prompts + hint count, never answers. */
export function publicQuestions(course) {
  return course.questions.map((q) => {
    const row = {
      id: q.id,
      prompt: q.prompt,
      hintCount: q.hints.length,
      hasAnswer: q.answer !== null || q.inlineAnswer !== null,
    }
    // Omit absent keys entirely (dsh tool output must be lossless JSON —
    // `undefined` values are dropped by JSON.stringify and fail validation).
    if (q.options !== null && q.options !== undefined) row.options = q.options
    if (q.section !== null && q.section !== undefined) row.section = q.section
    if (q.passage !== null && q.passage !== undefined) row.passage = q.passage
    return row
  })
}

/** The visible (comment-stripped) rendering of the curriculum file. */
export function visibleDocument(course, text) {
  return stripComments(text)
}
