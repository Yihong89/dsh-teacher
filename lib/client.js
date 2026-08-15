/**
 * dsh-teacher Web client (hand-rolled module-loader bundle).
 *
 * This file is the package's client half: a classic script that registers
 * itself with the web shell through `window.__ModuleLoader__.load({ id,
 * factory })`. The factory receives a CJS-style `require` (module table);
 * only `react` is imported. No JSX, no TypeScript, no build step — plain
 * `React.createElement`.
 *
 * Registers:
 *  - `tool.call.toolview` keyed views for the teacher tools (quiz cards)
 *  - `conversation.input.left` "quiz" button inside the chat box (opens the
 *    LLM-free quiz popup fed by the `teacherQuiz` projection)
 *  - `conversation.input.right` "gaps" button inside the chat box (due badge)
 *  - `shell.overlay` gap panel (in-session ledger from `teacherGaps`
 *    projection; the durable cross-session ledger stays in /gaps and /retest)
 *  - `shell.overlay` quiz panel (MCQ / free-text, submit via
 *    POST /dsh-teacher/quiz/submit, then auto-sends a message so the LLM
 *    analysis runs)
 *  - Both buttons render only in teacher-agent sessions (isTeacherSession
 *    gate: `useSessions` agentPreset === 'teacher').
 *
 * @module dsh-teacher/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-teacher',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')

    // ---- tiny shared store: overlay open state + latest projections ----
    var store = { open: false, gaps: [], quizOpen: false, quiz: null, sessionId: undefined, listeners: [] }
    function emit() {
      for (var i = 0; i < store.listeners.length; i++) store.listeners[i]()
    }
    function subscribe(fn) {
      store.listeners.push(fn)
      return function () {
        var at = store.listeners.indexOf(fn)
        if (at >= 0) store.listeners.splice(at, 1)
      }
    }
    function setStoreOpen(open) {
      store.open = open
      emit()
    }
    function setStoreQuizOpen(open) {
      store.quizOpen = open
      emit()
    }

    // ---- helpers ---------------------------------------------------------
    function blockArgs(block) {
      try {
        return JSON.parse((block && (block.call && block.call.argsRaw)) || (block && block.argsRaw) || '{}')
      } catch (e) {
        return {}
      }
    }
    /** The settled tool's presentResult payload ({ card, title, content }). */
    function blockView(block) {
      return block && 'kind' in block && block.resultView ? block.resultView : null
    }
    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

    var DAY = 86400000
    function fmtDue(dueAt) {
      if (dueAt === null || dueAt === undefined) return ''
      var days = Math.max(1, Math.round((dueAt - Date.now()) / DAY))
      return days + 'd'
    }

    // ---- styles (inline, theme-variable driven where possible) -----------
    var CARD = {
      border: '1px solid var(--dsw-border-color, rgba(128,128,128,.25))',
      borderRadius: 8,
      padding: '8px 12px',
      margin: '4px 0',
      fontSize: 13,
      lineHeight: 1.5,
      background: 'var(--dsw-surface-color, transparent)',
    }
    // Floating panels (quiz popup, gaps panel) need an OPAQUE, theme-aware
    // background — --dsw-alias-bg-overlay is the theme's overlay/popover color
    // (falling back to the surface color, then white) so text behind the
    // popup never shows through.
    var PANEL_CARD = {
      border: '1px solid var(--dsw-border-color, rgba(128,128,128,.25))',
      borderRadius: 8,
      padding: '10px 14px',
      fontSize: 13,
      lineHeight: 1.5,
      background: 'var(--dsw-alias-bg-overlay, var(--dsw-surface-color, #ffffff))',
      boxShadow: '0 8px 30px rgba(0,0,0,.25)',
    }
    var CARD_TITLE = { fontWeight: 600, marginBottom: 4, color: 'var(--dsw-text-color, inherit)' }
    var CARD_BODY = { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
    var CHIP = {
      display: 'inline-block',
      borderRadius: 10,
      padding: '1px 8px',
      fontSize: 11,
      fontWeight: 600,
      marginRight: 6,
      textTransform: 'uppercase',
      color: '#fff',
    }
    var KIND_COLORS = { wrong: '#c0392b', vague: '#d35400', missing: '#8e44ad', exposed: '#16a085' }

    // ---- tool cards ------------------------------------------------------
    var OPTION_BUTTON = {
      textAlign: 'left', padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
      border: '1px solid var(--dsw-border-color, rgba(128,128,128,.25))',
      background: 'var(--dsw-surface-color, transparent)', fontSize: 13,
      color: 'var(--dsw-text-color, inherit)',
    }

    function QuestionCard(props) {
      var view = blockView(props.block)
      var content = view && view.content ? view.content : '…'
      var options = view && Array.isArray(view.options) ? view.options : []
      var send = props.send
      return h('div', { style: CARD, className: 'dsh-teacher-question-card' },
        h('div', { style: CARD_TITLE }, (view && view.title) || 'Question'),
        h('div', { style: CARD_BODY }, content),
        options.length > 0
          ? h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
              options.map(function (opt, i) {
                return h('button', {
                  key: i,
                  onClick: function () { if (typeof send === 'function') send(opt) },
                  style: OPTION_BUTTON,
                }, opt)
              }))
          : null,
      )
    }

    function VerdictCard(props) {
      var args = blockArgs(props.block)
      var view = blockView(props.block)
      var verdict = args.verdict
      var color = { correct: '#27ae60', partial: '#f39c12', wrong: '#c0392b', 'no-answer': '#7f8c8d' }[verdict] || '#7f8c8d'
      return h('div', { style: Object.assign({}, CARD, { borderLeft: '3px solid ' + color }), className: 'dsh-teacher-verdict-card' },
        h('span', { style: { fontWeight: 600, color: color } }, verdict ? 'Verdict: ' + verdict : 'Grade'),
        h('span', { style: { marginLeft: 8 } }, view && view.content ? view.content : ''),
      )
    }

    function GapChip(props) {
      var args = blockArgs(props.block)
      return h('div', { style: CARD, className: 'dsh-teacher-gap-card' },
        h('span', { style: Object.assign({}, CHIP, { background: KIND_COLORS[args.kind] || '#7f8c8d' }) }, args.kind || 'gap'),
        h('span', {}, args.topic || 'Gap recorded'),
      )
    }

    function RetestCard(props) {
      var view = blockView(props.block)
      return h('div', { style: CARD, className: 'dsh-teacher-retest-card' },
        h('div', { style: CARD_BODY }, view && view.content ? view.content : 'Retest'),
      )
    }

    // ---- gap button + panel ----------------------------------------------
    // NOTE: hooks run BEFORE any conditional return (React hook-order rule —
    // returning null early on the teacher gate would crash the slot entry).
    function GapsButton(props) {
      var value = (props.useProjection ? props.useProjection('teacherGaps') : null) || { gaps: [] }
      React.useEffect(function () {
        store.gaps = value.gaps || []
        emit()
      }, [value])
      var state = React.useState(store.open)
      React.useEffect(function () {
        return subscribe(function () {
          state[1](store.open)
        })
      }, [])
      if (!isTeacherSession(props)) return null
      var now = Date.now()
      var gaps = value.gaps || []
      var due = gaps.filter(function (g) { return g.status === 'open' && g.dueAt != null && g.dueAt <= now }).length
      var openCount = gaps.filter(function (g) { return g.status === 'open' }).length
      return h('button', {
        onClick: function () { setStoreOpen(!store.open) },
        title: 'Teacher gaps — ' + openCount + ' open' + (due ? ', ' + due + ' due' : ''),
        'aria-label': 'Teacher gaps panel',
        style: {
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 14, padding: '2px 6px',
          color: due > 0 ? '#e67e22' : 'var(--dsw-text-color, inherit)',
        },
      }, '🧑‍🏫' + (due > 0 ? ' ' + due : ''))
    }

    // ---- TTS speak toggle ------------------------------------------------
    // Runs the host /speak command via the session face (no model involved).
    /** Speak text with the browser's built-in TTS (sound comes out of the
     * user's own machine). Picks a voice by script (zh/en). */
    function speakBrowser(text) {
      if (typeof window === 'undefined' || typeof window.speechSynthesis !== 'object') return
      if (!text || !String(text).trim()) return
      try {
        window.speechSynthesis.cancel()
        var utter = new window.SpeechSynthesisUtterance(String(text))
        var isChinese = /[\u4e00-\u9fff]/.test(String(text))
        var want = isChinese ? 'zh' : 'en'
        try {
          var voices = window.speechSynthesis.getVoices()
          var voice = voices.find(function (v) { return v.lang && v.lang.toLowerCase().indexOf(want) === 0 }) || null
          if (voice !== null) utter.voice = voice
        } catch (e) {}
        window.speechSynthesis.speak(utter)
      } catch (e) {}
    }

    /** Text of an assistant node from its text blocks. Harness blocks use
     * `kind` ('text' = visible text, 'reasoning' = Think chain-of-thought);
     * accept the legacy `type` spelling too. */
    function assistantNodeText(node) {
      var blocks = node.blocks || []
      return blocks
        .filter(function (b) { return b !== null && (b.kind === 'text' || b.type === 'text') && typeof b.text === 'string' })
        .map(function (b) { return b.text })
        .join('\n')
        .trim()
    }

    /** The real conversation node behind a chat-store view wrapper. Chat
     * store entries are `{ key, kind, id, target, data }` — the assistant
     * step keeps its final message in `data.finalNode`. Returns the node
     * itself when it is already a raw conversation node. */
    function unwrapNode(node) {
      if (node === null || node === undefined) return null
      var d = node
      if (d.data !== undefined && d.data !== null && d.blocks === undefined && d.seq === undefined && d.kind !== 'assistant') {
        d = d.data
      }
      // An assistant-step's data holds the finalized message in `finalNode`
      // (running steps have no finalNode and stay unwrapped — they carry no
      // `kind`, so the assistant filter below skips them).
      if (d !== null && d !== undefined && d.finalNode !== undefined && d.finalNode !== null) {
        d = d.finalNode
      }
      return d
    }

    /** Latest assistant message text from the conversation snapshot, or null.
     * Checks both the legacy top-level `nodes` array and the `chat` store. */
    function latestAssistantText(session) {
      if (session === null || session === undefined) return null
      if (Array.isArray(session.nodes)) {
        for (var i = session.nodes.length - 1; i >= 0; i--) {
          var n = unwrapNode(session.nodes[i])
          if (n === null || n.kind !== 'assistant') continue
          var text = assistantNodeText(n)
          if (text) return { seq: n.seq, text: text }
        }
      }
      if (session.chat !== null && session.chat !== undefined) {
        var order = session.chat.order || []
        var nodes = session.chat.nodes
        var get = typeof nodes.get === 'function' ? function (id) { return nodes.get(id) } : function (id) { return nodes[id] }
        for (var j = order.length - 1; j >= 0; j--) {
          var m = unwrapNode(get(order[j]))
          if (m === null || m.kind !== 'assistant') continue
          var t = assistantNodeText(m)
          if (t) return { seq: m.seq, text: t }
        }
      }
      return null
    }

    function SpeakToggle(props) {
      var value = (props.useProjection ? props.useProjection('teacherQuiz') : null) || { speakEnabled: true, lastSpoken: null }
      var state = React.useState(value.speakEnabled !== false)
      React.useEffect(function () {
        state[1](value.speakEnabled !== false)
      }, [value.speakEnabled])
      // input seats inject the conversation snapshot as props.session (the
      // InputZone owner share); useSession is a fallback when present.
      var session = props.session || (props.useSession ? props.useSession(function (s) { return s }) : null)
      // NOTE: isTeacherSession calls useSessions (a hook) — compute it ONCE
      // during render and capture the boolean; calling it inside an effect
      // body would be an invalid hook call (React error #321, crashed slot).
      var isTeacher = isTeacherSession(props)
      // Explicit speak requests (speak tool / next_question auto-speak).
      var spokenSeqRef = React.useRef(0)
      // Last text spoken through the projection path — the assistant-message
      // listener skips it so a question the tool already read aloud is not
      // re-read when the model echoes it in its own reply.
      var spokenTextRef = React.useRef(null)
      React.useEffect(function () {
        var last = value.lastSpoken
        if (last === null || last === undefined) return
        if (last.seq <= spokenSeqRef.current) return
        spokenSeqRef.current = last.seq
        if (value.speakEnabled === false) return
        spokenTextRef.current = String(last.text || '')
        speakBrowser(last.text)
      }, [value.lastSpoken, value.speakEnabled])
      // Socratic walk: ALWAYS speak the teacher's assistant message text, so
      // questions the teacher asks in its own words are read aloud too (not
      // just next_question). Waits a beat so the learner sees the text before
      // the sound starts. The pending timer lives in a ref so later snapshot
      // re-renders do NOT cancel it — only a genuinely new message supersedes
      // the pending one (otherwise the post-answer response never speaks).
      var spokenMsgRef = React.useRef(null)
      var pendingSpeakRef = React.useRef(null)
      React.useEffect(function () {
        if (!isTeacher) return
        if (value.speakEnabled === false) return
        var msg = latestAssistantText(session)
        if (msg === null) return
        if (spokenMsgRef.current !== null && spokenMsgRef.current.seq === msg.seq && spokenMsgRef.current.text === msg.text) return
        if (pendingSpeakRef.current !== null && pendingSpeakRef.current.seq === msg.seq && pendingSpeakRef.current.text === msg.text) return
        if (spokenTextRef.current !== null && spokenTextRef.current === msg.text) return
        if (pendingSpeakRef.current !== null) {
          clearTimeout(pendingSpeakRef.current.timer)
          pendingSpeakRef.current = null
        }
        var timer = setTimeout(function () {
          pendingSpeakRef.current = null
          spokenMsgRef.current = msg
          speakBrowser(msg.text)
        }, 1000)
        pendingSpeakRef.current = { seq: msg.seq, text: msg.text, timer: timer }
      }, [session, value.speakEnabled, isTeacher])
      React.useEffect(function () {
        return function () {
          if (pendingSpeakRef.current !== null) clearTimeout(pendingSpeakRef.current.timer)
        }
      }, [])
      if (!isTeacher) return null
      var enabled = state[0]
      return h('button', {
        onClick: function () {
          var next = !enabled
          state[1](next)
          try {
            var sessions = pluginCtx.get('sessions')
            var binding = sessions === undefined ? undefined : sessions.binding(props.sessionId)
            if (binding !== undefined && typeof binding.session.command === 'function') {
              binding.session.command('/speak ' + (next ? 'on' : 'off')).catch(function () {})
            }
          } catch (e) {}
        },
        title: enabled ? 'TTS is on — click to mute' : 'TTS is muted — click to enable',
        'aria-label': 'Teacher speak toggle',
        style: {
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 14, padding: '2px 6px',
          color: enabled ? 'var(--dsw-text-color, inherit)' : '#8e8e8e',
          textDecoration: enabled ? 'none' : 'line-through',
        },
      }, '🔊')
    }

    function GapsPanel() {
      var openState = React.useState(store.open)
      var gapsState = React.useState(store.gaps)
      React.useEffect(function () {
        return subscribe(function () {
          openState[1](store.open)
          gapsState[1](store.gaps)
        })
      }, [])
      if (!openState[0]) return null
      var gaps = gapsState[0] || []
      var now = Date.now()
      return h('div', { style: { position: 'fixed', right: 16, top: 72, zIndex: 1000, maxWidth: 420, width: '90vw' } },
        h('div', { style: Object.assign({}, PANEL_CARD, { maxHeight: '70vh', overflow: 'auto' }), className: 'dsh-teacher-gaps-panel' },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
            h('span', { style: CARD_TITLE }, '🧑‍🏫 Knowledge gaps'),
            h('button', { onClick: function () { setStoreOpen(false) }, style: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 } }, '✕'),
          ),
          gaps.length === 0
            ? h('div', { style: { color: 'var(--dsw-text-color, inherit)', opacity: .6 } },
                'No gaps in this session yet. Ask the teacher to start (/teach).')
            : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0 } },
                gaps.map(function (g) {
                  var due = g.status === 'open' && g.dueAt != null && g.dueAt <= now
                  return h('li', { key: g.id || g.topic + String(g.createdAt), style: { display: 'flex', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--dsw-border-color, rgba(128,128,128,.15))' } },
                    h('span', { style: Object.assign({}, CHIP, { background: KIND_COLORS[g.kind] || '#7f8c8d' }) }, g.kind),
                    h('span', { style: { flex: 1, marginRight: 8 } }, g.topic),
                    h('span', { style: { fontSize: 11, whiteSpace: 'nowrap', color: due ? '#e67e22' : 'var(--dsw-text-color, inherit)', opacity: .8 } },
                      g.status === 'mastered' ? '✓ mastered' : due ? '⚠ due' : 'due ' + fmtDue(g.dueAt)),
                  )
                })),
          h('div', { style: { marginTop: 8, fontSize: 11, opacity: .55 } },
            'Durable ledger (across sessions): /gaps · Retest on demand: /retest'),
        ),
      )
    }

    // ---- LLM-free quiz popup --------------------------------------------
    // Centered modal: bigger panel (min(760px, 94vw)), dimmed backdrop so the
    // page behind is clearly separate and nothing shows through.
    var PANEL_WRAP = {
      position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
      zIndex: 1000, width: 'min(760px, 94vw)', maxWidth: 760,
    }
    var BACKDROP = {
      position: 'fixed', inset: 0, zIndex: 999,
      background: 'rgba(0, 0, 0, 0.35)',
    }
    var QUIZ_INPUT = {
      width: '100%', boxSizing: 'border-box', minHeight: 72, marginTop: 8, padding: '8px 10px',
      borderRadius: 6, fontSize: 13, lineHeight: 1.5, resize: 'vertical',
      border: '1px solid var(--dsw-border-color, rgba(128,128,128,.25))',
      background: 'var(--dsw-surface-color, transparent)',
      color: 'var(--dsw-text-color, inherit)',
      fontFamily: 'inherit',
    }

    /** Send a user message (used after quiz submit to trigger LLM analysis). */
    var sendMsg = null
    /** The plugin's apply() context, captured for component-side host calls. */
    var pluginCtx = null

    /**
     * Teacher-only gate: the plugin's host rows publish process-globally
     * (preset rows without an isolate realm), so the projection and hydration
     * reach every session — the buttons must additionally check that THIS
     * session actually runs the teacher agent preset.
     */
    function isTeacherSession(props) {
      if (props.sessionId === undefined || typeof props.useSessions !== 'function') return false
      var preset = props.useSessions(function (s) { return s.byId[props.sessionId]?.agentPreset })
      return preset === 'teacher'
    }

    function QuizButton(props) {
      // Hooks first (React hook-order rule) — the teacher gate only decides
      // whether anything renders.
      var value = (props.useProjection ? props.useProjection('teacherQuiz') : null) || { course: null, quizActive: false, lastRun: null }
      React.useEffect(function () {
        store.quiz = value
        store.sessionId = props.sessionId
        emit()
      }, [value])
      // Auto-open the panel when quiz mode flips on (/quiz command).
      React.useEffect(function () {
        if (value.quizActive && !store.quizOpen) setStoreQuizOpen(true)
      }, [value.quizActive])
      var openState = React.useState(store.quizOpen)
      React.useEffect(function () {
        return subscribe(function () {
          openState[1](store.quizOpen)
        })
      }, [])
      if (!isTeacherSession(props)) return null
      var hasCourse = value.course !== null && Array.isArray(value.course.questions) && value.course.questions.length > 0
      if (!hasCourse) return null
      var pending = value.lastRun !== null && value.lastRun.status === 'pending'
      var count = value.course.questions.length
      return h('button', {
        onClick: function () { setStoreQuizOpen(!store.quizOpen) },
        title: 'Teacher quiz — ' + count + ' questions' + (pending ? ' · analysis pending' : ''),
        'aria-label': 'Teacher quiz panel',
        style: {
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 14, padding: '2px 6px',
          color: pending ? '#e67e22' : 'var(--dsw-text-color, inherit)',
        },
      }, '📝' + (pending ? ' ⏳' : ''))
    }

    function QuizPanel() {
      var openState = React.useState(store.quizOpen)
      var quizState = React.useState(store.quiz)
      var courseListState = React.useState([])
      var overrideState = React.useState(null)
      React.useEffect(function () {
        return subscribe(function () {
          openState[1](store.quizOpen)
          quizState[1](store.quiz)
        })
      }, [])
      // Fetch the course list once so the popup can switch subjects.
      React.useEffect(function () {
        fetch('/dsh-teacher/courses').then(function (r) { return r.json() }).then(function (res) {
          if (res && Array.isArray(res.courses)) courseListState[1](res.courses)
        }).catch(function () {})
      }, [])
      if (!openState[0]) return null
      var quiz = quizState[0]
      var projectionCourse = quiz !== null ? quiz.course : null
      var active = overrideState[0] || projectionCourse
      var questions = active !== null && Array.isArray(active.questions) ? active.questions : []
      if (questions.length === 0) {
        return h(React.Fragment, null,
          h('div', { style: BACKDROP, onClick: function () { setStoreQuizOpen(false) } }),
          h('div', { style: PANEL_WRAP },
            h('div', { style: PANEL_CARD, className: 'dsh-teacher-quiz-panel' },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
                h('span', { style: CARD_TITLE }, '📝 Quiz'),
                h('button', { onClick: function () { setStoreQuizOpen(false) }, style: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 } }, '✕'),
              ),
              h('div', { style: { color: 'var(--dsw-text-color, inherit)', opacity: .6 } },
                'No course loaded yet. Run /teach <path-to-questions.md> first.'),
            ),
          ),
        )
      }
      var pick = function (courseId) {
        fetch('/dsh-teacher/course/select', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ courseId: courseId }),
        }).then(function (r) { return r.json() }).then(function (res) {
          if (res && res.ok && res.course) overrideState[1](res.course)
        }).catch(function () {})
      }
      // key remounts QuizBody on course switch so answers/progress reset.
      return h(React.Fragment, null,
        h('div', { style: BACKDROP, onClick: function () { setStoreQuizOpen(false) } }),
        h(QuizBody, {
          key: String(active.courseId == null ? 'course' : active.courseId),
          courseId: active.courseId,
          title: active.title,
          questions: questions,
          courses: courseListState[0],
          activeCourseId: active.courseId,
          onPick: pick,
        }),
      )
    }

    function QuizBody(props) {
      var questions = props.questions
      var indexState = React.useState(0)
      var answersState = React.useState({})
      var hintOpenState = React.useState(false)
      var index = indexState[0]
      var answers = answersState[0]
      var q = questions[Math.min(index, questions.length - 1)]
      var answer = answers[q.id] || ''
      var setAnswer = function (value) {
        var next = Object.assign({}, answers)
        next[q.id] = value
        answersState[1](next)
      }
      var hasOptions = Array.isArray(q.options) && q.options.length > 0
      var finish = function () {
        var list = questions.map(function (qq) { return { qid: qq.id, answer: answers[qq.id] || '' } })
        var payload = { answers: list }
        if (props.courseId != null) payload.courseId = props.courseId
        fetch('/dsh-teacher/quiz/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function (res) { return res.json() }).then(function (res) {
          if (res && res.ok && res.runId != null && typeof sendMsg === 'function') {
            sendMsg('Quiz finished (run ' + res.runId + ') — analyze my results.')
          }
        }).catch(function () {})
        setStoreQuizOpen(false)
      }
      var picker = Array.isArray(props.courses) && props.courses.length > 1
        ? h('select', {
            value: String(props.activeCourseId == null ? '' : props.activeCourseId),
            onChange: function (e) {
              var id = Number(e.target.value)
              if (Number.isFinite(id) && typeof props.onPick === 'function') props.onPick(id)
            },
            style: {
              width: '100%', boxSizing: 'border-box', marginBottom: 8, padding: '4px 6px',
              fontSize: 12, borderRadius: 6,
              border: '1px solid var(--dsw-border-color, rgba(128,128,128,.25))',
              background: 'var(--dsw-surface-color, transparent)',
              color: 'var(--dsw-text-color, inherit)',
            },
          }, props.courses.map(function (c) {
            return h('option', { key: c.courseId, value: String(c.courseId) }, c.title + ' (' + c.questionCount + ')')
          }))
        : null
      return h('div', { style: PANEL_WRAP },
        h('div', { style: Object.assign({}, PANEL_CARD, { maxHeight: '86vh', overflow: 'auto' }), className: 'dsh-teacher-quiz-panel' },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
            h('span', { style: CARD_TITLE }, '📝 Quiz — ' + (props.title || 'course')),
            h('button', { onClick: function () { setStoreQuizOpen(false) }, style: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 } }, '✕'),
          ),
          picker,
          h('div', { style: { fontSize: 11, opacity: .6, marginBottom: 8 } },
            (index + 1) + ' / ' + questions.length + ' · LLM-free — answered locally'),
          q.section != null && h('div', { style: { fontSize: 11, opacity: .55, marginBottom: 4 } }, q.section),
          h('div', { style: Object.assign({}, CARD_BODY, { fontWeight: 600, marginBottom: 6 }) }, q.prompt),
          hasOptions
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                q.options.map(function (opt, i) {
                  var selected = answer === opt
                  return h('button', {
                    key: i,
                    onClick: function () { setAnswer(opt) },
                    style: Object.assign({}, OPTION_BUTTON, selected ? { border: '2px solid #27ae60' } : {}),
                  }, (selected ? '✓ ' : '') + opt)
                }))
            : h('textarea', {
                value: answer,
                onChange: function (e) { setAnswer(e.target.value) },
                placeholder: 'Type your answer…',
                style: QUIZ_INPUT,
              }),
          Array.isArray(q.hints) && q.hints.length > 0
            ? h('div', { style: { marginTop: 6 } },
                h('button', {
                  onClick: function () { hintOpenState[1](!hintOpenState[0]) },
                  style: Object.assign({}, OPTION_BUTTON, { fontSize: 12, padding: '3px 8px' }),
                }, hintOpenState[0] ? 'Hide hint' : '💡 hint'),
                hintOpenState[0] && h('div', { style: { marginTop: 4, fontSize: 12, opacity: .75 } }, q.hints[0]))
            : null,
          h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: 10 } },
            h('button', {
              onClick: function () { if (index > 0) indexState[1](index - 1) },
              disabled: index === 0,
              style: Object.assign({}, OPTION_BUTTON, { fontSize: 12 }),
            }, '← Prev'),
            index === questions.length - 1
              ? h('button', {
                  onClick: finish,
                  style: Object.assign({}, OPTION_BUTTON, { fontSize: 12, fontWeight: 600 }),
                }, 'Finish & analyze ✓')
              : h('button', {
                  onClick: function () { indexState[1](index + 1) },
                  style: Object.assign({}, OPTION_BUTTON, { fontSize: 12 }),
                }, 'Next →'),
          ),
          h('div', { style: { marginTop: 8, fontSize: 11, opacity: .55 } },
            'Finish submits your answers — the teacher then analyzes them with the AI and walks you through the misses.'),
        ),
      )
    }

    // ---- plugin ----------------------------------------------------------
    exports.name = 'dsh-teacher/client'
    exports.inject = ['slots', 'conversation']
    // Test-only exports (ignored by the plugin loader, which reads only
    // name/inject/apply).
    exports._test = { assistantNodeText, latestAssistantText, unwrapNode }
    exports.apply = function (ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      pluginCtx = ctx
      // Reliable message send for the post-quiz analysis trigger: address the
      // session-scoped conversation via ctx.sessions.scope(sessionId) — the
      // root-context ctx.conversation.send fails with "requires a session
      // scope" (which is why the old auto-send silently vanished). Falls back
      // to ctx.conversation.send when the scope is unavailable.
      sendMsg = function (text) {
        var attempt = function (svc) {
          try {
            svc.send(String(text)).catch(function () {})
            return true
          } catch (e) {
            return false
          }
        }
        try {
          var sessions = ctx.get('sessions')
          var scope = sessions === undefined ? undefined : sessions.scope(store.sessionId)
          if (scope !== undefined && scope.conversation !== undefined) {
            if (attempt(scope.conversation)) return
          }
        } catch (e) {}
        try {
          ctx.conversation.send(String(text)).catch(function () {})
        } catch (e2) {}
      }
      function keyed(key, component) {
        slots.inject('tool.call.toolview', function () {
          return slots.register({ name: 'tool.call.toolview', key: key }, component)
        })
      }
      // next_question: provide `send` so clicking an MC option auto-submits it
      // as the user's answer (no typing).
      slots.inject('tool.call.toolview', function () {
        return slots.register({
          name: 'tool.call.toolview', key: 'next_question',
          inject: function () {
            return {
              send: function (text) {
                try { ctx.conversation.send(String(text)).catch(function () {}) } catch (e) {}
              },
            }
          },
        }, QuestionCard)
      })
      keyed('grade_answer', VerdictCard)
      keyed('note_gap', GapChip)
      keyed('retest', RetestCard)
      // Teacher controls live INSIDE the chat box: quiz on the leading side
      // of the composer tool row, gaps on the trailing side. Both are gated
      // to teacher-agent sessions (isTeacherSession).
      slots.inject('conversation.input.left', function () {
        return slots.register(
          { name: 'conversation.input.left', id: 'dsh-teacher-quiz', order: 10, label: function () { return 'Quiz' } },
          QuizButton,
        )
      })
      slots.inject('conversation.input.right', function () {
        return slots.register(
          { name: 'conversation.input.right', id: 'dsh-teacher-speak', order: 9, label: function () { return 'Speak' } },
          SpeakToggle,
        )
      })
      slots.inject('conversation.input.right', function () {
        return slots.register(
          { name: 'conversation.input.right', id: 'dsh-teacher-gaps', order: 10, label: function () { return 'Gaps' } },
          GapsButton,
        )
      })
      slots.inject('shell.overlay', function () {
        return slots.register({ name: 'shell.overlay', id: 'dsh-teacher-gaps-panel', order: 30 }, GapsPanel)
      })
      slots.inject('shell.overlay', function () {
        return slots.register({ name: 'shell.overlay', id: 'dsh-teacher-quiz-panel', order: 25 }, QuizPanel)
      })
    }

    return module.exports
  },
})
