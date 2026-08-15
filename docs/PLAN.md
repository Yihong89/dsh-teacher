# dsh-teacher — Development Plan

> A DeepSeek Harness (DSH) plugin that turns the agent into a teacher: you hand it a
> markdown file of questions, it leads you to the answers with the Socratic method
> instead of telling you, quietly keeps a ledger of the gaps it notices in your
> reasoning, and retests those gaps a few days later on a spaced-repetition schedule.

Status: **Planning** · Target runtime: DSH (Cordis plugin, host + web client) · License: MIT

---

## 1. Vision & positioning

Chat with an LLM defaults to "answer at you". Learning research says the opposite
works better: retrieval practice beats re-reading, spaced reviews beat cramming, and
making the student *produce* the answer (even wrongly, then being corrected) beats
being told it.

`dsh-teacher` inverts the default conversation inside DSH:

1. **Curriculum from the user.** The user provides a markdown file of questions
   (exam prep, onboarding checklists, interview questions, lecture review). That file
   is the syllabus.
2. **The teacher never tells.** The agent walks the user through each question with
   Socratic micro-questions, waiting for the user to reach the answer themselves.
3. **Gap radar.** While teaching, the agent detects gaps — wrong, vague, or missing
   parts of the user's reasoning — and records them with the evidence (what the user
   actually said) into a per-session gap ledger.
4. **The gaps come back.** The ledger persists. Retesting is **on-demand** — the
   user runs `/retest` whenever they want, and the teacher drills due gaps in FSRS
   order. Nothing is forced and no notifications are sent.

### Why this niche is empty

Research of the DSH ecosystem (August 2025) found **no existing DSH teacher/tutor
plugin**. The closest projects live in other ecosystems:

| Project | Platform | What it does | What it's missing vs. dsh-teacher |
|---|---|---|---|
| [timini/drill-me](https://github.com/timini/drill-me) | Claude Code | Adaptive tutor, quiz-first, FSRS spacing, long-term memory of weak spots | No markdown-question curriculum; not DSH |
| [RoundTable02/socrates-skill](https://github.com/bevibing/socrates-skill) | Claude Code skill | "Never answers, always asks" Socratic tutor for any asset | No gap memory, no retest schedule |
| [zzguixzz/pbl-socratic](https://github.com/zzguixzz/pbl-socratic) | Claude Code skill | PBL + Socratic prep for assigned readings + question sets; persistent file suite | No spaced repetition; not DSH |
| [cendaifeng/dsh-learn-everything](https://github.com/cendaifeng/dsh-learn-everything) | **DSH** | Feynman `/learn` mode, `teach` tool, HTML lesson cards | Explicitly **no cross-session memory** — the gap/retest half is missing |
| [24kchengYe/human-skill-tree](https://github.com/24kchengYe/human-skill-tree) | Claude skill | Skill tree of human skills, spaced repetition + active recall + Socratic | Not DSH; no user-supplied question file |

`dsh-teacher` = drill-me's behavior (quiz-first, FSRS, shaky-area memory) ×
socrates-skill's discipline (never tell) × pbl-socratic's question-set workflow ×
dsh-learn-everything's DSH-native seams. That combination doesn't exist anywhere yet.

---

## 2. User stories

- **U1 (curriculum):** As a user, I paste/drop a `questions.md` (or type
  `/teach <path>`) and the teacher starts with question 1.
- **U2 (Socratic loop):** The teacher asks one micro-question at a time. It never
  states the answer directly — it asks again, rephrases, gives a hint only when I'm
  stuck, and confirms only after I've produced a full answer.
- **U3 (gap radar):** When I answer wrongly, vaguely, or "I don't know", the teacher
  records a gap: topic, my exact words, the question it came from, and my stated
  confidence.
- **U4 (retest, on-demand):** When I ask for it (or type `/retest`), the teacher
  drills the due gaps, grades them, and updates the schedule (mastered → longer
  interval, still shaky → due again soon). The teacher never retests on its own.
- **U5 (status):** `/gaps` shows the ledger: what's shaky, what's due, what's
  mastered. `/teach off` exits teacher mode.
- **U6 (escape hatch):** I may say "just tell me" — the teacher gives the answer and
  marks that gap as *exposed*, so it will be retested sooner, not forgotten.

---

## 3. Feature spec

### F0 — Curriculum intake (markdown questions file)

- Accept a markdown file path (via drag/drop, `/teach <path>`, or workspace file).
- Supported format (see §5 for the full grammar):

  ```markdown
  ---
  title: Networking review
  ---
  ## Q1: What happens when TCP handshake fails?
  <!-- answer: ... -->            <!-- optional: hidden answer key -->

  ## Q2: Why does rebase rewrite history?
  ```

- The file is the syllabus: question order = teaching order; `title`/frontmatter
  names the course; optional hidden answer keys (HTML comments or a separate
  `answers.md`) exist so the *model* can grade against the ground truth without the
  *user* seeing them.

### F1 — Teacher mode (prompt policy)

- Session-scoped mode toggle: `/teach on|off` (mirrors dsh-learn-everything's
  `/learn` design).
- While on, a conditional **`teacher:policy`** system-prompt section (in the style of
  dsh-learn-everything's `learning:policy`) injects the Socratic contract:
  - **hard Socratic by default:** never give the answer directly; one micro-question
    at a time;
  - adapt depth to the user's level (simplify / deepen / redirect);
  - when the user is stuck, offer a hint *level* before any content;
  - **knowledge-lack fallback:** if the user demonstrably lacks prerequisite
    knowledge (the *same* micro-point failed twice, or an explicit "I don't know what
    X is"), stop re-asking and *teach the missing prerequisite explicitly* — a short,
    concrete explanation with an example — then resume questioning. Never ask the
    same micro-question more than twice.
  - always teach in the user's language;
  - log a gap when the user's answer is wrong/vague/absent — via the `note_gap` tool,
    never by narrating "I've noted that";
  - "just tell me" → expose the answer AND record an `exposed` gap.
- When off, the section renders empty (zero token cost, like `learning:policy`).

### F2 — Question delivery (tool contract)

The model never sees the whole question set in one go; it pulls one question at a
time so it cannot accidentally dump answers:

| Tool | Purpose |
|---|---|
| `next_question` | Return the next question (id, prompt, options). **Answer key never in tool output.** |
| `import_curriculum` | LLM-assisted course import: the model reads any markdown question file, extracts questions + correct answers, and emits them in the standard format (`## Q<n>: prompt` + `<!-- answer: -->`); the host validates and loads the course. |
| `note_gap` | Record `{question_id, topic, user_quote, confidence, kind: wrong\|vague\|missing\|exposed}` into the ledger. The `topic` is the knowledge point the teacher identified. |
| `grade_answer` | Grade a completed question against the hidden key/rubric → `{mastered, gaps[]}`; marks due items; schedules retest. |
| `retest` | Pull the due gap list (scheduled by FSRS) for a drill round. |

> **Hints and knowledge points are generated by the LLM teacher, not parsed from
> the file.** The markdown file is the source of questions and answers only. This
> is what keeps the parser simple (one canonical format for `import_curriculum`)
> and the teaching adaptive.

### F3 — Gap ledger (session + persistent)

- **In-session:** every gap is appended to the session as a `teacher/gap` session
  event (log-only state, foldable on resume/compaction — same pattern as
  dsh-learn-everything's `learning/mode`).
- **Persistent:** the ledger is flushed to local storage (SQLite, see D4) keyed by
  workspace + course. This is the only cross-session state the plugin holds.
- **Schema (§6)** tracks `question_id`, `topic`, `evidence`, `confidence`,
  `created_at`, `due_at`, `interval_days`, `ease`, `status`.

### F4 — Spaced retest scheduling (FSRS-5)

- Use the FSRS-5 algorithm (the model behind Anki / drill-me) rather than a naive
  "retest in 3 days":
  - after `grade_answer`, compute next interval from `ease`, `stability`, `difficulty`
    and the rating (again / hard / good / easy);
  - a gap that was `exposed` (user gave up) gets a short interval; a confidently-wrong
    gap gets a medium one (hypercorrection effect — confident errors are the most
    correctable).
- **Retesting is on-demand only.** `due_at` is advisory: `/retest` (or "retest me")
  drills everything due, sorted by due date. The teacher never initiates a retest
  and sends no notifications.
- Keep it dependency-free: a compact FSRS-5 implementation (log-linear recurrence,
  ~100 lines) inside the plugin. No external runtime deps.

### F5 — Web client (later milestone)

- Lesson/quiz cards via `tool.call.toolview` (reuse the pattern dsh-learn-everything
  proves works: keyed tool views).
- A "Gap radar" side panel: shaky topics, due badges, mastered list; `/gaps`
  equivalent in the UI.
- Teacher persona styling only — no shell changes.

---

## 4. Architecture

Cordis plugin, host + client halves (same layout philosophy as dsh-learn-everything):

```
dsh-teacher/
├── cordis.patch.yml          # plugin rows: host global + paired client bundle
├── package.json              # dsh.bundle.patch declared profile layer
├── src/
│   ├── index.ts              # host entry (name / inject / Config / apply)
│   ├── controller.ts         # TeacherController: /teach state machine + prompt section
│   ├── policy.ts             # teacher:policy guidance text (single source of truth)
│   ├── curriculum.ts         # markdown parser → Course { questions[], answers[] }
│   ├── tools.ts              # next_question / note_gap / grade_answer / retest / hint
│   ├── grading.ts            # rubric + gap extraction from a graded answer
│   ├── fsrs.ts               # FSRS-5 scheduler (pure, unit-tested)
│   ├── ledger.ts             # gap records + SQLite persistence seam
│   ├── fold.ts               # teacher/gap event folding (resume-safe)
│   ├── types.ts              # shared host/client types
│   └── client/
│       ├── index.ts          # toolview registrations + gap panel
│       ├── QuizCard.tsx      # question / hint / grade UI
│       ├── GapPanel.tsx      # ledger view + due badge
│       └── styles.ts         # --dsw-* themed styles
├── tests/                    # vitest: fsrs, curriculum parser, fold, grading, e2e
├── docs/
│   ├── PLAN.md               # this file
│   └── ACCEPTANCE.md         # milestone acceptance matrix
└── README.md
```

### Seams used (zero mainline core changes — all proven by dsh-learn-everything)

| Need | Seam |
|---|---|
| Teacher behavior only when on | Conditional prompt section (`teacher:policy`), empty when off |
| Structured teaching output | Tools registered on `ctx` (always-registered catalog, execution gated on mode) |
| Session state that survives resume/compaction | Log-only session events + folding (`teacher/gap`) |
| Rich cards in Web UI | `tool.call.toolview` keyed views (client bundle) |
| Mode toggles | Slash commands (`/teach`, `/gaps`, `/retest`) |

### Persistence decision

| Option | Verdict |
|---|---|
| **SQLite (node:sqlite, no runtime deps)** | ✅ **Chosen.** DSH runs on Node ≥ 22; `node:sqlite` is built in. Single ledger table. |
| Reuse `dsh-memento` (ctx.memory seam) | Fallback if the plugin should ride an existing memory provider; but it couples us to another plugin's approval gate. |
| JSON file | Too fragile for concurrent sessions; no querying. |

---

## 5. Key design decisions (with recommendations)

- **D1 — Answer secrecy (decided: keys in the question file).** Answer keys are
  embedded in the **same markdown file**, as HTML comments (`<!-- answer: ... -->`)
  that the plugin's parser extracts and then strips before anything user-visible.
  The host passes the key to `grade_answer` internally; the model's visible stream
  only ever carries questions, hints, and grades. Keys never appear in tool output
  or the visible prompt.
- **D2 — Grading.** Model-judged grading against the hidden key, with the model
  required to quote the user's exact words in each gap record. Rubric-anchored
  (checkbox-style criteria in the key) for questions where grading is subjective.
- **D3 — Socratic strictness (decided: hard mode + knowledge-lack fallback).**
  Hard Socratic always: never reveal the answer; escalate hint levels.
  **Exception:** when the user demonstrably lacks prerequisite knowledge (the *same*
  micro-point failed twice, or an explicit "I don't know what X is"), the teacher
  *teaches the missing prerequisite explicitly* (short explanation + example) and
  then resumes questioning — it never loops the same question a third time. "just
  tell me" is always honored and logged as `exposed` (exposed gaps get a short
  retest interval, per F4).
- **D4 — Persistence.** `node:sqlite` ledger, one row per gap, keyed by
  `(workspace, course, question_id)`. The plugin owns the file (under
  `$DSH_HOME/state/dsh-teacher/` or the workspace `.dsh/`), no external service.
- **D5 — Scheduling.** FSRS-5, embedded. Fallback to a 4-box Leitner ladder if FSRS
  proves overkill in v0.1.
- **D6 — Scope of "session memory".** The gap *ledger* is durable; the *conversation*
  is not. Teacher mode state is folded session state (resume-safe), not a new
  persistent model.
- **D7 — Command vs. automatic.** `/teach on` required to start teaching (never
  hijack a normal conversation); retest rounds auto-trigger only at session open when
  due items exist.

---

## 6. Data model

### Curriculum (markdown grammar, v0.1)

```markdown
---
title: <course title>          # optional; used as ledger key
lang: en                       # optional
---
## Q<n>: <prompt>
<!-- answer: <ground truth / rubric bullets> -->   # optional hidden key

### hints                             # optional, escalating
<!-- hint 1: <gentle nudge> -->
<!-- hint 2: <stronger nudge> -->
```

The parser extracts questions **and** answer keys from the same file; keys are
stripped from everything the user/model sees. Questions without a key are graded by
the model's own expertise (rubric-anchored judging); keys are strongly recommended.

### Gap ledger (SQLite DDL)

```sql
CREATE TABLE gaps (
  id            TEXT PRIMARY KEY,          -- "<course>::<question_id>::<seq>"
  workspace     TEXT NOT NULL,
  course        TEXT NOT NULL,
  question_id   TEXT NOT NULL,
  topic         TEXT NOT NULL,             -- "tcp handshake failure modes"
  kind          TEXT NOT NULL,             -- wrong | vague | missing | exposed
  evidence      TEXT NOT NULL,             -- verbatim user quote / paraphrase
  confidence    INTEGER,                   -- 1..5 user-stated, NULL if absent
  status        TEXT NOT NULL DEFAULT 'open',  -- open | due | mastered | archived
  interval_days REAL NOT NULL DEFAULT 1,
  ease          REAL NOT NULL DEFAULT 2.5,
  stability     REAL NOT NULL DEFAULT 1.0,
  difficulty    REAL NOT NULL DEFAULT 5.0,
  created_at    INTEGER NOT NULL,          -- epoch ms
  due_at        INTEGER NOT NULL,          -- epoch ms
  last_reviewed INTEGER
);
CREATE INDEX idx_gaps_due ON gaps(workspace, status, due_at);
-- Retesting is purely on-demand via /retest (U4); no notifications.
```

---

## 7. Milestones

| # | Milestone | Deliverables | Acceptance |
|---|---|---|---|
| **M0** | Scaffold | Repo layout, `cordis.patch.yml`, package.json with `dsh.bundle.patch`, empty host plugin that mounts in a dev profile, vitest setup | Plugin mounts; `/teach on` toggles state with zero errors |
| **M1** | Core Socratic loop | Curriculum parser, `next_question`/`hint`/`grade_answer` tools, `teacher:policy` section, `/teach on/off` | Real-model e2e: user answers Q1 with a wrong answer → teacher guides → user reaches correct answer → `grade_answer` marks mastered |
| **M2** | Gap ledger + persistence | `note_gap` tool, `teacher/gap` events, fold(), SQLite ledger, `/gaps` command | Gap survives session restart; `/gaps` lists it; fold round-trip unit-tested |
| **M3** | FSRS retest | `fsrs.ts`, `retest` tool | fsrs unit tests vs. published FSRS vectors; e2e: gap created on day 1, `/retest` drills it on demand and reschedules |
| **M4** | Web client | Quiz cards + Gap panel via toolview, settings page (mode, escape hatch, data location) | Playwright snapshot tests; panel renders ledger from a real session |
| **M5** | Publish | README with Model Experience, ACCEPTANCE.md, `dsh-plugin` topic, awesome-dsh submission, npm publish if desired | `dsh-plugin-verify` passes; installable via `dsh plugin` |

### Implementation status (2025-08)

M0–M3 are implemented in `v0.1.0` with **30/30 unit tests passing** (`npm test`),
committed to `main`. Deviations from this plan, all deliberate:

- **Plain JavaScript instead of TypeScript/tsdown.** No DSH source tree is required
  to build (`DSH_SOURCE_DIR` linking, as dsh-learn-everything uses). The plugin is
  zero-build: `package.json` `main` → `index.js`, `cordis.patch.yml` declares the
  bundle row, and runtime imports (`@deepseek-ai/dsh-tools`) resolve from the DSH
  install, exactly like the installed `dsh-plugin-manager`.
- **Tests use `node:test`** (no vitest dependency) and cover only pure logic; the
  host integration (`index.js`) is syntax-checked and follows the inspected DSH
  seams (`systemPrompt.section`, `commands.register`, `tools.register`,
  `session.append`, `agent/pre-step`).
- **FSRS-5 pinned against the official ts-fsrs interval vector**
  `[0,4,14,44,125,328,0,0,7,16,34,71,142]` (test/fsrs.test.js).
- **M3 acceptance marked "e2e"** — the real-model e2e (a live `/teach` session)
  still needs a running DSH profile with the plugin installed; unit coverage
  substitutes for it until M5.

### M4 — Web client (v0.2.0, 2025-08)

Implemented as a **hand-rolled `__ModuleLoader__` bundle** (`lib/client.js`, plain
JS + `React.createElement`, no build step — same zero-build principle as the host
half). It is declared via `dsh.client` in package.json
(`platform: web`, `inject: [client-runtime, client-ui-slots]`) and served at the
`./client` exports subpath, mirroring the shipped `dsh-usage-plugin` conventions:

- **Quiz cards** — `tool.call.toolview` keyed views for `next_question`,
  `grade_answer`, `note_gap`, `hint`, `retest`; the host tools now ship
  `presentCall`/`presentResult` so both the default rendering and the custom
  cards show structured content (question prompt, color-coded verdict, gap
  chips by kind).
- **Gaps button + overlay panel** — `conversation.session.header.actions`
  (id `dsh-teacher-gaps`, due-count badge) and `shell.overlay`
  (id `dsh-teacher-gaps-panel`); shared in-bundle store for open state.
- **Gap projection** — host folds `teacher/gap` + `teacher/grade` session events
  into the `teacherGaps` projection (zod-schema-validated, `stateVersion 1`),
  read by the client via the slot `useProjection` hook (the dsh-usage-plugin
  pattern). The projection covers the current session; the durable cross-session
  ledger remains in `/gaps` and `/retest`.
- **Tests** — `test/gap-projection.test.js` (pure fold, zero-work contract) and
  `test/client-bundle.test.js` (evals the bundle with a mocked
  `__ModuleLoader__` + react stub; asserts registrations and renders the cards
  against mock `ToolCallOwnerProps`). Total suite: **43/43**.
- **Deferred to M5:** settings page (`settings.section`), host RPC for the
  durable ledger in the panel (the `harness` builtin is dynamic-plugin-only in
  this runtime, so the panel reads the projection instead), and Playwright
  snapshot tests (needs the plugin installed in a running web profile).

---

## 8. Risks & open questions

### Resolved decisions (2025-08)

| # | Decision |
|---|---|
| 1 | **Retest is on-demand only** (`/retest` or "retest me"); the teacher never initiates a retest and sends **no notifications** (notification feature deferred). |
| 2 | **Hard Socratic mode always** — with a knowledge-lack fallback: if the user demonstrably lacks prerequisites (same micro-point failed twice, or explicit "I don't know what X is"), the teacher gives a short, concrete explanation (with example) and then resumes questioning. Never the same question more than twice. |
| 3 | **Answer keys live in the same markdown file**, as HTML comments (`<!-- answer: ... -->`). The plugin reads the file once, extracts questions and answers, strips keys from everything user/model-visible, and grades against them internally. |

### Risks

- **Answer leakage.** The #1 risk: the model quoting an answer key into the visible
  stream. Mitigation: keys never enter the visible context (host-side grading only).
- **"Lacks knowledge" misdetection.** The fallback trigger (twice-wrong / explicit
  "don't know") is a heuristic; it can misfire. Mitigation: require the *same*
  micro-point to fail twice, or an explicit admission, before teaching — and log a
  gap either way.
- **FSRS complexity.** Algorithm tuning is fiddly; v0.1 may ship the Leitner fallback
  first (D5).
- **`node:sqlite` availability.** Verify the Node version DSH pins; if < 22, fall
  back to a JSON append-only ledger behind the same `ledger.ts` seam.

### Remaining open questions

1. FSRS vs. a simpler Leitner ladder for v0.1 (plan defaults to FSRS-5; D5).
2. Should `/gaps` also show the next due date per gap, or only status + topic?

---

## 9. References

### Inspirations
- [timini/drill-me](https://github.com/timini/drill-me) — quiz-first adaptive tutor, FSRS, cross-session shaky-area memory, `/drill:status`; the behavioral model for dsh-teacher.
- [cendaifeng/dsh-learn-everything](https://github.com/cendaifeng/dsh-learn-everything) — the DSH-native blueprint: `/learn` state machine, conditional prompt section, `teach` tool, toolview cards, log-only session state.
- [RoundTable02/socrates-skill](https://github.com/bevibing/socrates-skill) — the "never answers, always asks" 5-step Socratic workflow.
- [zzguixzz/pbl-socratic](https://github.com/zzguixzz/pbl-socratic) — assigned readings + question sets, one question per session, persistent continuation files.
- [24kchengYe/human-skill-tree](https://github.com/24kchengYe/human-skill-tree) — spaced repetition + active recall + Socratic dialogue as a Claude skill collection.
- [st3v3nmw/obsidian-tutor](https://github.com/st3v3nmw/obsidian-tutor) — notes-as-tutor with spaced repetition.
- DSH memory infra (potential reuse): [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon), [dsh-memento](https://github.com/PerryLink/dsh-memento), [dsh-memory-vault](https://github.com/flymysql/dsh-memory), [dsh-memoria](https://github.com/jiayan-xu/dsh-memoria).

### Science
- Roediger & Karpicke (2006), *Testing effect* — retrieval practice g ≈ 0.61 over re-reading. https://doi.org/10.1111/j.1467-9280.2006.01693.x
- Wilson et al. (2019), *Nature Communications* — ~15% error rate is optimal difficulty. https://www.nature.com/articles/s41467-019-12552-4
- FSRS (Free Spaced Repetition Scheduler) — https://github.com/open-spaced-repetition/fsrs4anki (algorithm used by Anki and drill-me).
- Hypercorrection effect — confident errors are the most correctable; motivation for recording user confidence on every gap.

---

## 10. v0.3 redesign: SQLite question store + LLM-free quiz popup + post-quiz Socratic analysis

> Design decision (2026-08-15): the plugin moves from an in-memory/JSON course to a
> **built-in SQLite question store**. The LLM is used **only at parse time** (file →
> DB records) and **after** a quiz (results → analysis + Socratic walk). The quiz
> itself is **LLM-free**: questions come from the DB and are shown in a popup UI.

### 10.1 Goals

1. **Durable question bank.** Parsed questions persist as DB records per workspace,
   surviving restarts, instead of a JSON course file.
2. **LLM at the seams only.** The model extracts structured questions from a file at
   import time; after a quiz it grades and walks the misses. During the quiz no LLM
   call happens — a popup UI drives the whole test.
3. **Quiz results flow back.** The popup posts answers to the plugin (stored as a
   quiz run); the teacher then analyzes that run with the LLM and runs the Socratic
   walk on the wrong questions.

### 10.2 Data model — `lib/question-store.js`

Mirrors `lib/ledger.js`: SQLite via `node:sqlite` (Node ≥ 22.5) with a JSON-file
fallback. File: `$DSH_HOME/state/dsh-teacher/question-store.db` (override:
`DSH_TEACHER_STORE`), JSON fallback at `question-store.json`.

```sql
CREATE TABLE IF NOT EXISTS courses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace  TEXT NOT NULL,            -- session cwd (ledger convention)
  title      TEXT NOT NULL,
  source     TEXT,                     -- file path or 'llm-import'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  qid        TEXT NOT NULL,            -- logical id within the course (q1, …)
  position   INTEGER NOT NULL,
  prompt     TEXT NOT NULL,
  answer_key TEXT,                     -- kept server-side; never on the wire
  options    TEXT,                     -- JSON array | NULL
  hints      TEXT,                     -- JSON array | NULL
  section    TEXT,
  passage    TEXT,
  UNIQUE (course_id, qid)
);

CREATE TABLE IF NOT EXISTS quiz_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  workspace  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  answers    TEXT NOT NULL,            -- JSON: [{ qid, answer, confidence? }]
  status     TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'analyzed'
  analysis   TEXT                      -- JSON set by the LLM analysis tool
);
```

Store API:

- `upsertCourse({ workspace, title, source, questions })` → replaces the
  workspace's latest course + question rows atomically.
- `latestCourse(workspace)` → `{ courseId, title, source, questions[] }`
  (questions carry answer keys internally) or `null`.
- `publicCourse(workspace)` → same shape **without** `answer_key` (safe for
  session events / projections / wire).
- `createQuizRun({ workspace, courseId, answers })` → `{ runId }`.
- `getQuizRun(runId)` → `{ courseId, workspace, answers, questions[] }` (with keys).
- `markQuizRunAnalyzed(runId, analysis)`.

**Migration from v0.2:** on first `latestCourse()` miss, if the legacy
`course-<workspace>.json` file exists it is upserted once and the JSON kept as a
read-only fallback.

### 10.3 LLM-based parsing → DB records

No new model plumbing is needed: the model already reads the dropped/pointed file
and either (a) the tolerant parser handles it directly (`/teach <path>`) or (b) the
model converts it and calls `import_curriculum`. Both paths now **persist into
SQLite**:

- `controller.loadCourse(agent, path)` → parse → `store.upsertCourse` → session
  course → append `teacher/course` event.
- `import_curriculum` → re-parse the model-emitted markdown → `store.upsertCourse`
  (source `'llm-import'`) → session course → `teacher/course` event.
- `courseOf()` fallback order: session memory → `store.latestCourse(workspace)` →
  legacy JSON import → null.

New session event **`teacher/course`**: `{ title, source, questions: publicQuestions(course) }`
(never answer keys). This is what the quiz popup reads, so it works **without the
model** and survives restart (the log is persisted).

### 10.4 LLM-free quiz popup (client)

New session projection **`teacherQuiz`** (same pattern as `teacherGaps`), folding:

- `teacher/course` → `course` (public questions),
- `teacher/quiz` → `quizActive`,
- `teacher/quiz-run` → `lastRun` (runId, status).

Client (`lib/client.js`, hand-rolled React, no build step):

- **Header action** `📝 Quiz` next to the gaps button; enabled when the projection
  has a course. Opens the quiz panel; the panel auto-opens when `quizActive` flips
  true (`/quiz` command).
- **Quiz panel** (`shell.overlay`):
  - one question per screen: section/passage, prompt, **MCQ option buttons** when
    `options` exist, else a **free-text input** (the fallback);
  - selection highlight, Next/Prev, progress `3 / 10`, Finish;
  - Finish → `POST /dsh-teacher/quiz/submit` with `{ answers: [{ qid, answer }] }`
    → host stores the run and appends `teacher/quiz-run` → the panel then calls
    `ctx.conversation.send('Quiz finished — analyze my results')` so the LLM
    analysis starts automatically.
- **No LLM anywhere in the quiz path**: questions come from the projection, answers
  go to the host over HTTP.

### 10.5 Post-quiz LLM analysis + Socratic walk

Host side:

- `POST /dsh-teacher/quiz/submit` (webServer route, aionui-panel pattern; lazy
  `ctx.get('webServer')` so headless profiles still work): validates the JSON,
  `createQuizRun`, appends `teacher/quiz-run`, returns `{ runId, accepted: true }`.
  The route never serves answer keys (answers in, run id out).
- New model tool **`analyze_quiz(runId)`**: returns the run's questions
  (id, prompt, options, **answer_key** — the model is the trusted teacher; keys are
  never rendered to the user), the user's answers, and per-question hints. The model
  grades each answer (correct/partial/wrong/no-answer), records gaps via
  `note_gap`, updates FSRS via `grade_answer`, and walks the misses Socratic-style.
- Policy section (`buildPolicy`) gains a clause: when `teacherQuiz.lastRun.status
  === 'pending'`, the teacher analyzes it on the next turn (call `analyze_quiz`,
  grade, walk the misses). Combined with the popup's auto-send, the flow is: finish
  popup → model analyzes → Socratic walk, with the quiz itself LLM-free.

`teacher/quiz-run` is added to `KNOWN_SESSION_EVENT_TYPES` (index.js + register-events.js).

### 10.6 Component changes

| File | Change |
|---|---|
| `lib/question-store.js` | **new** — SQLite + JSON fallback store (courses/questions/quiz_runs). |
| `lib/quiz-projection.js` | **new** — `teacherQuiz` projection (course/quiz/quiz-run fold). |
| `index.js` | persist via question-store; `teacher/course` event; quiz-run append; `analyze_quiz` tool; `POST /dsh-teacher/quiz/submit` route; policy clause; register `teacher/quiz-run` event type. |
| `lib/register-events.js` | add `teacher/quiz-run` (and `teacher/course`, `teacher/quiz`) to the catalog. |
| `lib/course-store.js` | kept as legacy import fallback (v0.2 JSON). |
| `lib/client.js` | quiz button + quiz panel (MCQ/free-text, submit, auto-send). |
| `docs/README.md` | document the new flow (`/quiz` → popup → analysis). |
| `test/*` | new `question-store.test.js`, `quiz-projection.test.js`; update persistence tests for the DB; smoke tests updated for the new tool + event types. |

### 10.7 Security notes

- `teacherQuiz` projection and `teacher/course` events carry **no answer keys**.
- `/dsh-teacher/*` routes accept answers only and return run ids; they must never
  serve keys or analysis. Like `/aionui-panel/*`, they are plain webServer routes —
  do not expose the web server to untrusted networks (standard DSH caveat).
- SQLite stores keys locally under `$DSH_HOME` (mode 0600 via the existing dir
  permissions) — same trust as the gap ledger.

### 10.8 Test plan

1. `question-store.test.js` — upsert/latest/public course, quiz-run lifecycle,
   JSON fallback, key-separation (public omits `answer_key`).
2. `quiz-projection.test.js` — fold `teacher/course` + `teacher/quiz` +
   `teacher/quiz-run`; same-reference no-op contract.
3. `persistence.test.js` — course survives restart through the DB; legacy JSON
   import path.
4. `host-smoke.test.js` — tool catalog now includes `analyze_quiz`; event catalog
   accepts `teacher/quiz-run`.
5. Manual e2e on the mini: `/teach questions.md` → `/quiz` → popup answers → auto
   analysis → Socratic walk of misses.

### 10.9 Extension: one GLOBAL shared course pool

The question store is **global — every teacher session shares the same
courses, quiz runs, selection, and gap ledger** (English, Science, Chinese,
Math … coexist as one pool):

- `upsertCourse` keys by **title only** (`workspace` is written as `'global'`
  and never scopes): re-importing the same title replaces that course (id
  kept); different titles create separate courses. Sessions without a cwd no
  longer fragment the store into session-id rows.
- `preferences` holds a single **global selected course**; new sessions
  hydrate it (logged courseId → selection → latest → legacy JSON).
- The gap ledger keys by the fixed `'global'` workspace, so gaps are shared
  across sessions too.
- `/course` lists the shared courses and switches the active one; the quiz
  popup renders a **course picker** (`GET /dsh-teacher/courses` +
  `POST /dsh-teacher/course/select`) so a teacher session can switch subjects
  without any LLM involvement.
