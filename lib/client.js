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
 *  - `tool.call.toolview` keyed views for the five teacher tools (quiz cards)
 *  - `conversation.session.header.actions` "gaps" button (due badge)
 *  - `shell.overlay` gap panel (in-session ledger from `teacherGaps`
 *    projection; the durable cross-session ledger stays in /gaps and /retest)
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

    // ---- tiny shared store: overlay open state + latest projection ----
    var store = { open: false, gaps: [], listeners: [] }
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
    function QuestionCard(props) {
      var view = blockView(props.block)
      var content = view && view.content ? view.content : '…'
      return h('div', { style: CARD, className: 'dsh-teacher-question-card' },
        h('div', { style: CARD_TITLE }, (view && view.title) || 'Question'),
        h('div', { style: CARD_BODY }, content),
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
        h('div', { style: Object.assign({}, CARD, { boxShadow: '0 8px 30px rgba(0,0,0,.25)', maxHeight: '70vh', overflow: 'auto' }), className: 'dsh-teacher-gaps-panel' },
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

    // ---- plugin ----------------------------------------------------------
    exports.name = 'dsh-teacher/client'
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      function keyed(key, component) {
        slots.inject('tool.call.toolview', function () {
          return slots.register({ name: 'tool.call.toolview', key: key }, component)
        })
      }
      keyed('next_question', QuestionCard)
      keyed('grade_answer', VerdictCard)
      keyed('note_gap', GapChip)
      keyed('retest', RetestCard)
      slots.inject('conversation.session.header.actions', function () {
        return slots.register(
          { name: 'conversation.session.header.actions', id: 'dsh-teacher-gaps', order: 15, label: function () { return 'Gaps' } },
          GapsButton,
        )
      })
      slots.inject('shell.overlay', function () {
        return slots.register({ name: 'shell.overlay', id: 'dsh-teacher-gaps-panel', order: 30 }, GapsPanel)
      })
    }

    return module.exports
  },
})
