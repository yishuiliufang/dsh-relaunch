/**
 * dsh-relaunch — Client half.
 *
 * Adds one rail entry to the left sidebar and the panel behind it. The panel is
 * where the restart actually happens, because the operation is destructive: it
 * must be an explicit, deliberate click rather than something that fires while
 * the user is looking elsewhere.
 *
 * Layout facts this file depends on (verified against the shipped client):
 *   - `sidebar.panellist` entries carry `id`, `order` and `label`, and draw
 *     their own glyph (there is no icon field in the registration). `label` may
 *     be a thunk, which is what lets it follow a language switch without
 *     re-registering.
 *   - `main` is keyed by that same id, and its props come from the seat.
 *
 * The restart itself is not reachable from the Client: no Client Service
 * exposes restart/relaunch/quit. The panel therefore POSTs to the Host route
 * this package's Host half registers, and that route launches a detached
 * worker.
 *
 * All visible text goes through the `locale` service. The catalogue is
 * registered here rather than shipped as files, because the panel is the only
 * consumer and the dictionary must be in place before the first render. When
 * `locale` is absent (an older composition) the English text is used directly,
 * so the panel never renders a bare key.
 */
window.__ModuleLoader__.load({
  id: '@yishuiliufang/dsh-relaunch',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** Panel identity. The rail entry and the main panel must agree. */
    const PANEL_ID = 'restart-app'
    /** Host route registered by this package's Host half. */
    const ROUTE = '/dsh-relaunch/restart'
    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-relaunch'

    /**
     * Every string the panel and the rail entry can show.
     *
     * Keyed by the two locales the client ships. The English column doubles as
     * the fallback used when the locale service is unavailable, so a missing
     * registration degrades to readable English rather than a raw key.
     */
    const TEXTS = {
      en: {
        'rail.label': 'Relaunch Harness',
        'panel.title': 'Relaunch Harness',
        'panel.body': 'Close and start DeepSeek Harness again. Running tasks are interrupted.',
        'panel.action': 'Relaunch Harness',
        'panel.busy': 'Relaunching…',
        'panel.pending': 'Going down…',
        'panel.sent': 'Harness is restarting. This window will close and reopen.',
      },
      zh: {
        'rail.label': '重启 Harness',
        'panel.title': '重启 Harness',
        'panel.body': '关闭并重新启动 DeepSeek Harness。正在运行的任务会被中断。',
        'panel.action': '重启 Harness',
        'panel.busy': '正在重启…',
        'panel.pending': '即将重启…',
        'panel.sent': 'Harness 正在重启，本窗口会关闭并重新打开。',
      },
    }

    /**
     * Resolve one key, with the English column as the fallback.
     *
     * @param {(key: string) => string} [translate] - the bound locale reader.
     * @param {string} key - the text key.
     * @returns {string} the localized text.
     */
    function text(translate, key) {
      if (typeof translate === 'function') {
        const value = translate(key)
        // The service returns the key itself when nothing is registered.
        if (typeof value === 'string' && value !== key) return value
      }
      return TEXTS.en[key] ?? key
    }

    /**
     * The circular-arrow restart glyph, drawn to the rail's square edge.
     * @param {{size: number, active: boolean}} props - owner props.
     * @returns {object} a React element.
     */
    function RestartIcon({ size, active }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.85 },
        },
        h('path', { d: 'M20 11a8 8 0 1 0-2.6 5.9' }),
        h('path', { d: 'M20 5v6h-6' }),
      )
    }

    /**
     * The panel behind the rail entry: one restart control with explicit state.
     *
     * @param {{translate?: (key: string) => string}} props - seat props.
     * @returns {object} a React element.
     */
    function RestartPanel({ translate }) {
      const [phase, setPhase] = React.useState('idle')
      const [message, setMessage] = React.useState('')

      const restart = React.useCallback(async () => {
        setPhase('running')
        setMessage('')
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ delaySeconds: 3 }),
          })
          const body = await response.text()
          let data = {}
          try { data = body === '' ? {} : JSON.parse(body) } catch { data = {} }
          if (!response.ok || data.ok !== true) {
            setPhase('failed')
            setMessage(data.message ?? `HTTP ${String(response.status)}`)
            return
          }
          // The app is going away in a moment; leave the panel in its running
          // state rather than pretending a completed restart is observable here.
          setPhase('restarting')
          setMessage(text(translate, 'panel.sent'))
        } catch (error) {
          setPhase('failed')
          setMessage(error instanceof Error ? error.message : String(error))
        }
      }, [translate])

      const busy = phase === 'running' || phase === 'restarting'

      return h(
        'div',
        { style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', { style: { fontSize: '14px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } },
          text(translate, 'panel.title')),
        h('div', { style: { fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } },
          text(translate, 'panel.body')),
        h('button',
          {
            type: 'button',
            disabled: busy,
            onClick: restart,
            style: {
              alignSelf: 'flex-start',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 14px',
              fontSize: '13px',
              fontWeight: 500,
              borderRadius: 'var(--dsw-radius-md, 8px)',
              border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.3))',
              background: busy
                ? 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12))'
                : 'var(--dsw-alias-button-elevated-fill, rgba(128,128,128,0.08))',
              color: 'var(--dsw-alias-label-primary)',
              cursor: busy ? 'default' : 'pointer',
            },
          },
          h(RestartIcon, { size: 16, active: false }),
          phase === 'running'
            ? text(translate, 'panel.busy')
            : phase === 'restarting'
              ? text(translate, 'panel.pending')
              : text(translate, 'panel.action'),
        ),
        message === ''
          ? null
          : h('div', {
              style: {
                fontSize: '12px',
                lineHeight: 1.5,
                color: phase === 'failed'
                  ? 'var(--dsw-alias-state-error-primary, #d33)'
                  : 'var(--dsw-alias-label-secondary)',
              },
            }, message),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Register both language columns first: the rail label is read on every
        // projection, so a dictionary arriving after registration would show the
        // key until the next locale change.
        let translate
        let disposers = []
        if (ctx.locale !== undefined && ctx.locale !== null) {
          for (const [locale, dict] of Object.entries(TEXTS)) {
            try {
              disposers.push(ctx.locale.register(NS, locale, dict))
            } catch (error) {
              console.error(`dsh-relaunch: registering the ${locale} dictionary failed`, error)
            }
          }
          try {
            translate = ctx.locale.bind(NS)
          } catch (error) {
            console.error('dsh-relaunch: binding the locale namespace failed', error)
          }
        }

        // The two seats are registered from the innermost callback, exactly as
        // the shipped panels do: the rail entry and the panel it opens appear
        // together or not at all.
        try {
          if (ctx.slots === undefined || ctx.slots === null) {
            console.error('dsh-relaunch: this DSH has no slots service; the panel stays unmounted')
            for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } }
            return
          }
          ctx.slots.inject('main', () =>
            ctx.slots.inject('sidebar.panellist', () => {
              const stopMain = ctx.slots.register(
                { name: 'main', key: PANEL_ID, inject: () => ({ translate }) },
                RestartPanel,
              )
              const stopIcon = ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 70,
                  // A thunk is re-read on every projection, so the label follows
                  // the active locale without re-registering.
                  label: () => text(translate, 'rail.label'),
                },
                RestartIcon,
              )
              return () => {
                if (typeof stopIcon === 'function') stopIcon()
                if (typeof stopMain === 'function') stopMain()
                for (const dispose of disposers) {
                  if (typeof dispose === 'function') { try { dispose() } catch { /* ignore */ } }
                }
                disposers = []
              }
            }),
          )
        } catch (error) {
          console.error('dsh-relaunch: registering the restart panel failed', error)
          for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } }
        }
      },
    }
  },
})
