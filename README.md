# dsh-teacher 🧑‍🏫

> A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin that turns the agent
> into a teacher — **never answers, always asks.**

Give it a markdown file of questions. It leads you to the answers with the Socratic
method, keeps a quiet ledger of the gaps it notices in your reasoning, and retests
those gaps on-demand on a spaced-repetition schedule.

## The loop

```
questions.md  ──▶  /teach questions.md
                      │  Q1: "What happens when TCP handshake fails?"
                      │    └─ you (wrong) ──▶ hint ──▶ you (right) ──▶ grade ✓
                      │  Q2: "Why does rebase rewrite history?"
                      │    └─ "idk" ──▶ gap noted: rebase, evidence="idk", missing
                      ▼
            gap ledger (persists across sessions, SQLite)
                      │  you: "/retest" (on-demand, anytime)
                      ▼
            "Explain rebase to me."  ──▶  graded, rescheduled (FSRS-5)
```

## Status

**v0.2.0 — core + Web client implemented, tests passing (43/43).**

| Milestone | Status |
|---|---|
| M0 Scaffold (bundle patch, plugin row, zero-build JS) | ✅ |
| M1 Core Socratic loop (curriculum parser, policy section, 5 tools) | ✅ |
| M2 Gap ledger + persistence (SQLite + JSON fallback, session events) | ✅ |
| M3 FSRS-5 spaced retest (official test vector pinned) | ✅ |
| M4 Web client (quiz cards, gaps button + panel, gap projection) | ✅ |
| M5 Publish (dsh-plugin topic ✓, awesome lists, live e2e) | ◐ |

Design decisions are in [docs/PLAN.md](docs/PLAN.md).

## Web client

Once the plugin is installed and the web profile restarted, the browser bundle
(`lib/client.js`, registered via `dsh.client`) adds:

- **Quiz cards** — custom `tool.call.toolview` cards for `next_question`,
  `grade_answer`, `note_gap`, `hint`, and `retest` (question prompt, verdict
  color-coded by outcome, gap chips by kind).
- **🧑‍🏫 gaps button** — in the session header action row, shows a due-count badge
  and opens the gap panel.
- **Gap panel** — floating overlay listing this session's gaps (kind, topic,
  due/✓ mastered), fed by the `teacherGaps` session projection (same seam
  dsh-usage-plugin uses). The durable cross-session ledger stays in `/gaps` and
  `/retest`.

## Install

Requires DSH rc.6+ and Node ≥ 22.5 (uses built-in `node:sqlite`).

```bash
dsh plugin --profile web add "github:Yihong89/dsh-teacher"
# restart dsh --profile web
```

## Usage

```markdown
# questions.md  — answer keys live in HTML comments; the teacher grades
#                 against them internally and never shows them to you.
---
title: Networking review
---
## Q1: What happens when TCP handshake fails?
<!-- answer: SYN gets no SYN-ACK; the client retries then times out -->
### hints
<!-- hint 1: Think about the three-way handshake. -->
```

| Command | What it does |
|---|---|
| `/teach questions.md` | Load the question set and enter teacher mode |
| `/teach on` / `/teach off` | Toggle teacher mode (mode is session state, survives resume) |
| `/gaps` | Show the gap ledger for this course |
| `/retest` | Surface due gaps for an on-demand drill (FSRS-5 schedule) |

### Teacher behavior (model tools)

- **`next_question`** — pulls one question at a time; the answer key never appears in tool output.
- **`import_curriculum`** — loads any markdown question file: read the raw file, extract each question + correct answer, emit them in the standard format. Used when the automatic parser can't make sense of a file's format.
- **`note_gap`** — records a gap (`wrong | vague | missing | exposed`) with the user's verbatim words + the knowledge point you identified; persisted to the ledger and the session log.
- **`grade_answer`** — grades against the hidden answer key; updates each open gap's FSRS schedule; `correct` marks gaps mastered.
- **`retest`** — returns due gaps; drill them one at a time, then `grade_answer`.

Per the policy section (injected only while teacher mode is active): hard Socratic
mode — never reveal the answer, one micro-question at a time; **hints are generated
by the teacher** from the user's answers (escalating, never the answer);
**knowledge-lack fallback** — the same micro-question fails twice or the user says
"I don't know what X is" → explain the missing knowledge point concisely (definition
+ example), never repeat the question a third time; "just tell me" → answer + record
an `exposed` gap.

## Input formats

The automatic parser is **format-tolerant**: it recognizes questions in many shapes
(numbered items, `Q1:` items, `## Q<n>:` headings), answer markers (`→ **Answer:**`,
`Answer:`, `答案：`, ✅/bold multiple-choice options, `<!-- answer: -->` comments),
and hints (`> **Key words:**`, `> **Trap:**`, `> 关键词：`, comments). Questions that
carry no answer/options/hints are treated as prose and skipped.

If a file still won't parse, tell the teacher "import this file" — it converts the
file with `import_curriculum` (LLM-assisted) into the standard format. The markdown
file supplies questions and answers; **hints and knowledge points always come from
the teacher's own generation**, not from the file.

## Why it exists

Chatbots explain at you; cognitive science says that's the least effective way to
teach. Retrieval practice, spaced reviews, and making the student produce the answer
(pretesting) beat passive reading — even when the first attempt is wrong.
`dsh-teacher` builds that evidence into the DSH agent. See the landscape survey in
[docs/PLAN.md §1](docs/PLAN.md).

## Development

```bash
npm test          # node:test — zero runtime deps beyond DSH itself
```

- `lib/` — pure logic (curriculum parser, FSRS-5, grading, folding, ledger, gap
  projection); fully unit-tested, no DSH imports.
- `index.js` — the Cordis host plugin (prompt section, commands, tools, session
  events, `teacherGaps` projection). Written in plain JS (no build step); imports
  `@deepseek-ai/dsh-tools` and `zod` at runtime, resolved from the DSH install /
  npm.
- `lib/client.js` — the Web client: a hand-rolled `__ModuleLoader__` bundle
  (plain JS + `React.createElement`, no build step) declaring `dsh.client` in
  package.json and registered at the `./client` exports subpath.
- Ledger location: `$DSH_HOME/state/dsh-teacher/ledger.db` (falls back to `.json`).

## License

MIT
