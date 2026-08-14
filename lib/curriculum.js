/**
 * Markdown curriculum parser.
 *
 * Grammar (v0.1, see docs/PLAN.md §6):
 *
 * ```markdown
 * ---
 * title: Networking review
 * lang: en
 * ---
 * ## Q1: What happens when TCP handshake fails?
 * <!-- answer: SYN is sent; SYN-ACK; ACK -->
 *
 * ### hints
 * <!-- hint 1: Think about the three-way handshake. -->
 * <!-- hint 2: Which flag opens the connection? -->
 * ```
 *
 * The parser extracts questions **and** hidden answer keys (HTML comments) from
 * the same file. Keys and hints are never part of the visible question text:
 * `Course.publicQuestions()` strips them for anything the user or model sees.
 */

/** Strip HTML comments from a markdown string. */
export function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '')
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

/** Parse a question heading like `## Q1: ...` or `## What is X?`. */
function questionIdFromHeading(heading) {
  const m = heading.match(/^Q\s*([\d.]+)\s*[:：]\s*(.*)$/i)
  if (m) return { id: `q${m[1]}`, prompt: m[2].trim() }
  return { id: null, prompt: heading.trim() }
}

/**
 * Parse a curriculum markdown document.
 * @param {string} text raw markdown
 * @returns {{ title: string|null, lang: string|null, questions: Array<{id, prompt, answer, hints}> }}
 */
export function parseCurriculum(text) {
  const lines = text.split(/\r?\n/)
  const meta = parseFrontmatter(lines)
  const questions = []
  let current = null
  let inHints = false

  const finalize = () => {
    if (current && (current.prompt || current.answer || current.hints.length)) {
      if (!current.id) current.id = slugify(current.prompt || 'q')
      // Ensure unique ids.
      const seen = new Set(questions.map((q) => q.id))
      let base = current.id
      let n = 2
      while (seen.has(current.id)) current.id = `${base}-${n++}`
      questions.push(current)
    }
    current = null
    inHints = false
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const heading = line.match(/^##\s+(.+)$/)
    if (heading) {
      finalize()
      const { id, prompt } = questionIdFromHeading(heading[1])
      current = { id, prompt, answer: null, hints: [] }
      inHints = false
      continue
    }
    if (current === null) continue
    if (/^###\s+hints?$/i.test(line)) {
      inHints = true
      continue
    }
    const hint = line.match(/^<!--\s*hint\s*\d*\s*[:：]\s*([\s\S]*?)-->\s*$/)
    if (hint) {
      const text2 = hint[1].trim()
      if (text2) current.hints.push(text2)
      continue
    }
    const answer = line.match(/^<!--\s*answer\s*[:：]\s*([\s\S]*?)-->\s*$/)
    if (answer) {
      current.answer = answer[1].trim() || null
      inHints = false
      continue
    }
    if (inHints) {
      const m = line.match(/^<!--\s*(.+?)-->\s*$/)
      if (m) {
        const t = m[1].trim()
        if (t) current.hints.push(t)
      }
    }
  }
  finalize()
  return { title: meta.title ?? null, lang: meta.lang ?? null, questions }
}

/** Questions as the model may see them: prompts + hint count, never answers. */
export function publicQuestions(course) {
  return course.questions.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    hintCount: q.hints.length,
    hasAnswer: q.answer !== null,
  }))
}

/** The visible (comment-stripped) rendering of the curriculum file. */
export function visibleDocument(course, text) {
  return stripComments(text)
}
