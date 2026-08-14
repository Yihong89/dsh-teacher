# dsh-teacher 🧑‍🏫

> A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin that turns the agent
> into a teacher — **never answers, always asks.**

Give it a markdown file of questions. It leads you to the answers with the Socratic
method, keeps a quiet ledger of the gaps it notices in your reasoning, and retests
those gaps a few days later on a spaced-repetition schedule.

## The loop

```
questions.md  ──▶  /teach on
                      │  Q1: "What happens when TCP handshake fails?"
                      │    └─ you (wrong) ──▶ hint ──▶ you (right) ──▶ grade ✓
                      │  Q2: "Why does rebase rewrite history?"
                      │    └─ "idk" ──▶ gap noted: rebase, evidence="idk", exposed
                      ▼
            gap ledger (persists across sessions)
                      │  you: "/retest" (on-demand, anytime)
                      ▼
            "Explain rebase to me."  ──▶  graded, rescheduled
```

## Status

🛠 **Planning.** Full design in [docs/PLAN.md](docs/PLAN.md). No code yet.

| Milestone | Status |
|---|---|
| M0 Scaffold | ☐ |
| M1 Core Socratic loop | ☐ |
| M2 Gap ledger + persistence | ☐ |
| M3 FSRS spaced retest | ☐ |
| M4 Web client | ☐ |
| M5 Publish | ☐ |

## Why it exists

Chatbots explain at you; cognitive science says that's the least effective way to
teach. Retrieval practice, spaced reviews, and making the student produce the answer
(pretesting) beat passive reading — even when the first attempt is wrong.
`dsh-teacher` builds that evidence into the DSH agent, and it's the only DSH-native
plugin doing so (see the landscape survey in [docs/PLAN.md §1](docs/PLAN.md)).

## License

MIT
