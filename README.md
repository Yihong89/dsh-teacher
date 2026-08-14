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

**v0.1.0 — core implemented, tests passing (30/30).**

| Milestone | Status |
|---|---|
| M0 Scaffold (bundle patch, plugin row, zero-build JS) | ✅ |
| M1 Core Socratic loop (curriculum parser, policy section, 5 tools) | ✅ |
| M2 Gap ledger + persistence (SQLite + JSON fallback, session events) | ✅ |
| M3 FSRS-5 spaced retest (official test vector pinned) | ✅ |
| M4 Web client (quiz cards, gap panel) | ☐ |
| M5 Publish (dsh-plugin topic, awesome lists) | ☐ |

Design decisions are in [docs/PLAN.md](docs/PLAN.md).

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
- **`hint`** — escalating hints, never the answer.
- **`note_gap`** — records a gap (`wrong | vague | missing | exposed`) with the user's verbatim words + confidence; persisted to the ledger and the session log.
- **`grade_answer`** — grades against the hidden key; updates each open gap's FSRS schedule; `correct` marks gaps mastered.
- **`retest`** — returns due gaps; drill them one at a time, then `grade_answer`.

Per the policy section (injected only while teacher mode is active): hard Socratic
mode — never reveal the answer, one micro-question at a time; **knowledge-lack
fallback** — the same micro-question fails twice or the user says "I don't know what
X is" → teach the missing prerequisite explicitly, never repeat the question a third
time; "just tell me" → answer + record an `exposed` gap.

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

- `lib/` — pure logic (curriculum parser, FSRS-5, grading, folding, ledger); fully
  unit-tested, no DSH imports.
- `index.js` — the Cordis host plugin (prompt section, commands, tools, session
  events). Written in plain JS (no build step); imports `@deepseek-ai/dsh-tools`
  at runtime, resolved from the DSH install.
- Ledger location: `$DSH_HOME/state/dsh-teacher/ledger.db` (falls back to `.json`).

## License

MIT
