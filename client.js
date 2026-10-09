/**
 * dsh-plugin-session-purge — Client half.
 *
 * Two contributions, both reaching the Host operation over the Host's exact
 * Fetch route `/api/session-purge` (the Host half owns that operation; this
 * half owns no deletion logic of its own):
 *
 *   - one `sidebar.workspaces.session.menu.item` row, placed after the shipped
 *     Archive row (order 400), which opens the confirmation surface;
 *   - one `shell.overlay` entry rendering that confirmation surface and the
 *     result notice.
 *
 * The menu row and the dialog are ordinary host-styled controls written here:
 * this module requires nothing but `react` from the browser module table, so no
 * Harness Client package is loaded and no second copy of a primitive is
 * bundled. Colours come from `--dsw-alias-*` tokens with literal fallbacks, so
 * a renamed token degrades the surface instead of breaking it.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-purge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    /** Locale namespace of this bundle's visible copy. */
    const NS = 'sessionPurge'
    /**
     * The Host route, in the document-relative form the browser resolves
     * against the served page's own base — the same shape the shipped
     * session-log export uses, so a mount prefix needs no special case.
     */
    const ROUTE = '/api/session-purge'.slice(1)

    const ZH = {
      'menu.delete': '放入回收站',
      'dialog.title': '放入回收站',
      'dialog.close': '关闭',
      'dialog.desc': '「{title}」将从侧栏消失，文件移入回收站——在你关掉 DSH 之前都可以恢复。真正的删除发生在下次启动时。',
      'dialog.planning': '正在核对要删除的内容…',
      'dialog.scope': '将要移出',
      'dialog.target': '{id}',
      'dialog.subagents': '以及它名下的 {count} 个子代理会话',
      'dialog.directory': '{path}',
      'dialog.noDirectory': '（该会话没有落盘目录）',
      'dialog.kept': '共享的附件字节和派生搜索索引不在删除范围内（附件被其他会话共用）。回收站目录：<harness home>\\session-purge-trash。',
      'dialog.cancel': '取消',
      'dialog.confirm': '放入回收站',
      'dialog.deleting': '正在移入回收站…',
      'dialog.retry': '重试',
      'toast.done': '已把「{title}」放入回收站，下次启动 DSH 时真正删除',
      'toast.partial': '「{title}」已移入回收站，但有部分内容没能移动（见控制台）',
      'error.unknown-session': '会话存储里已经没有它了（可能已经被删除过）。',
      'error.caller-session': '不能删除正在执行这次操作的会话。',
      'error.no-sessions-root': '定位不到会话存储根目录，为安全起见拒绝删除（不猜路径）。',
      'error.invalid-request': '请求参数不合法，已中止。',
      'error.bad-request': '请求体不合法，已中止。',
      'error.failed': '宿主内部出错，已中止（没有删除任何内容）。',
      'bin.open': '回收站',
      'bin.title': '会话回收站',
      'bin.loading': '正在读取回收站…',
      'bin.empty': '回收站是空的。放入回收站的会话会在这里等着，直到下次启动 DSH 时被真正删除。',
      'bin.timing': '真正的删除发生在下次启动 DSH 时；在那之前，每一条都可以恢复。每行的「立刻删除」跳过等待，现在就删。',
      'bin.restore': '恢复',
      'bin.restoring': '正在恢复…',
      'bin.purge': '立刻删除',
      'bin.purging': '正在删除…',
      'bin.orphans': '孤儿子代理会话',
      'bin.orphanMove': '放入回收站',
      'bin.orphanMoving': '正在放入…',
      'bin.clear': '清空回收站',
      'bin.clearing': '正在清空…',
      'bin.close': '关闭',
    }

    const EN = {
      'menu.delete': 'Move to Recycle Bin',
      'dialog.title': 'Move to Recycle Bin',
      'dialog.close': 'Close',
      'dialog.desc': '"{title}" leaves the sidebar and its files move to the recycle bin, where you can restore it until DSH closes. The real deletion happens on the next start.',
      'dialog.planning': 'Checking what would be removed…',
      'dialog.scope': 'Will be moved out',
      'dialog.target': '{id}',
      'dialog.subagents': 'plus {count} subagent sessions it owns',
      'dialog.directory': '{path}',
      'dialog.noDirectory': '(this session has no directory on disk)',
      'dialog.kept': 'Shared attachment bytes and the derived search index stay: attachments are shared with other sessions.',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Move to Recycle Bin',
      'dialog.deleting': 'Moving to the recycle bin…',
      'dialog.retry': 'Retry',
      'toast.done': '"{title}" is in the recycle bin; DSH deletes it for real on the next start',
      'toast.partial': '"{title}" is gone, but some content could not be cleaned (see the console)',
      'error.unknown-session': 'Session storage no longer holds it (it may already have been deleted).',
      'error.caller-session': 'The session running this operation cannot delete itself.',
      'error.no-sessions-root': 'The session storage root could not be located, so deletion was refused rather than guessed.',
      'error.invalid-request': 'The request was not valid and nothing was removed.',
      'error.bad-request': 'The request body was not valid and nothing was removed.',
      'error.failed': 'The Host failed and nothing was removed.',
      'bin.open': 'Recycle Bin',
      'bin.title': 'Session recycle bin',
      'bin.loading': 'Reading the recycle bin…',
      'bin.empty': 'The recycle bin is empty. Sessions you move here wait until DSH starts again, which is when they are deleted for real.',
      'bin.timing': 'The real deletion happens on the next DSH start; until then every entry can be restored. A row\'s "Delete now" skips the wait and deletes it for real right away.',
      'bin.restore': 'Restore',
      'bin.restoring': 'Restoring…',
      'bin.purge': 'Delete now',
      'bin.purging': 'Deleting…',
      'bin.orphans': 'Orphan subagent sessions',
      'bin.orphanMove': 'Move to the bin',
      'bin.orphanMoving': 'Moving…',
      'bin.clear': 'Empty the bin',
      'bin.clearing': 'Emptying…',
      'bin.close': 'Close',
    }

    /**
     * Refusal codes the Host reports, mapped to localizable copy.
     *
     * The Host answers in English (it has no idea which locale the page is in),
     * so every code a reader can actually hit gets a dictionary key here; an
     * unmapped code falls through to the Host's own message rather than being
     * swallowed.
     */
    const REFUSAL_KEYS = {
      'session-purge/unknown-session': 'error.unknown-session',
      'session-purge/caller-session': 'error.caller-session',
      'session-purge/no-sessions-root': 'error.no-sessions-root',
      'session-purge/invalid-request': 'error.invalid-request',
      'session-purge/bad-request': 'error.bad-request',
      'session-purge/unknown-endpoint': 'error.failed',
      'session-purge/failed': 'error.failed',
    }

    const STYLES = `
.session-purge-separator { height: .5px; margin: 3px 2px; background: var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.session-purge-item {
  display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px; padding: 6px 8px;
  border: none; border-radius: var(--dsw-radius-md, 8px); background: transparent; cursor: pointer;
  font-family: inherit; font-size: 13px; line-height: 20px; text-align: left;
  color: var(--dsw-alias-state-error-primary, #e5484d);
}
.session-purge-item:hover, .session-purge-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(229,72,77,.14)); outline: none; }
/* The safe half of a two-button row (Restore beside "Delete now"): same
   geometry, ordinary text colour, and a neutral hover instead of the danger wash. */
.session-purge-safe { color: var(--dsw-alias-label-primary, #f5f5f5); }
.session-purge-safe:hover, .session-purge-safe:focus-visible { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.session-purge-item-icon { display: inline-flex; flex: none; width: 14px; height: 14px; align-items: center; justify-content: center; }
.session-purge-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.session-purge-modal {
  pointer-events: auto; position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px;
}
.session-purge-mask { position: absolute; inset: var(--dsh-frame-chrome-top, 0px) 0 0; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.45)); }
.session-purge-dialog {
  box-sizing: border-box; position: relative; z-index: 1; display: flex; flex-direction: column; gap: 14px;
  width: min(440px, 100%); max-height: 100%; padding: 22px 24px 20px; overflow: auto;
  border-radius: var(--dsw-radius-panel, 16px);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay, #202024));
  box-shadow: var(--dsw-elevation-prominent, 0 16px 40px rgba(0,0,0,.36));
  color: var(--dsw-alias-label-primary, #f5f5f5);
}
.session-purge-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.session-purge-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.session-purge-close {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  border: none; border-radius: var(--dsw-radius-sm, 6px); background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary, #a8a8ad);
}
.session-purge-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.session-purge-desc { margin: 0; font-size: 14px; line-height: 22px; }
.session-purge-section { display: flex; flex-direction: column; gap: 6px; }
.session-purge-label { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary, #a8a8ad); }
.session-purge-code {
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px; line-height: 18px; word-break: break-all;
  color: var(--dsw-alias-label-primary, #f5f5f5);
}
.session-purge-muted { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #a8a8ad); }
.session-purge-check { display: flex; align-items: center; gap: 8px; font-size: 13px; line-height: 20px; cursor: pointer; }
.session-purge-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #a8a8ad); }
.session-purge-error { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-state-error-primary, #e5484d); }
.session-purge-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.session-purge-btn {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; height: 36px;
  padding: 0 14px; border: none; border-radius: var(--dsw-radius-md, 8px); cursor: pointer;
  font-family: inherit; font-size: 14px; line-height: 22px; background: transparent;
  color: var(--dsw-alias-label-primary, #f5f5f5);
}
.session-purge-btn:disabled { opacity: .4; cursor: not-allowed; }
.session-purge-btn-outline { border: .5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2, rgba(127,127,127,.32))); }
.session-purge-btn-outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.session-purge-btn-danger { background: var(--dsw-alias-state-error-primary, #e5484d); color: #fff; }
.session-purge-btn-danger:hover:not(:disabled) { filter: brightness(1.07); }

.session-purge-toast {
  pointer-events: auto; position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 1000;
  max-width: min(560px, calc(100vw - 48px)); padding: 10px 16px; border-radius: var(--dsw-radius-md, 8px);
  border: .5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24));
  background: var(--dsw-alias-bg-overlay, #26262a); color: var(--dsw-alias-label-primary, #f5f5f5);
  box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.3));
  font-size: 13px; line-height: 20px;
}
.session-purge-toast-error { color: var(--dsw-alias-state-error-primary, #e5484d); }
`

    /** Minimal external store: one value, synchronous notification. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    /** The pending confirmation, `{ sessionId, displayTitle }` or null. */
    const requestStore = createStore(null)
    /** The transient result notice, `{ text, error }` or null. */
    const toastStore = createStore(null)

    /** Subscribe one component to one store value. */
    function useStoreValue(store) {
      const [value, setValue] = React.useState(store.get())
      React.useEffect(() => {
        setValue(store.get())
        return store.subscribe(() => setValue(store.get()))
      }, [store])
      return value
    }

    /** One style element for the whole plugin, removed with its effect. */
    function insertStyles(css) {
      const element = document.createElement('style')
      element.setAttribute('data-dsh-plugin', 'session-purge')
      element.textContent = css
      document.head.appendChild(element)
      return () => element.remove()
    }

    /** Outline trash glyph, 14px, inheriting the row's colour. */
    function TrashIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M2.6 4.4h10.8' }),
        h('path', { d: 'M6.1 4.4V3.3a.8.8 0 0 1 .8-.8h2.2a.8.8 0 0 1 .8.8v1.1' }),
        h('path', { d: 'M4.2 4.4l.6 8.2a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.2' }),
        h('path', { d: 'M6.7 7.1v4' }),
        h('path', { d: 'M9.3 7.1v4' }),
      )
    }

    /** Small close glyph for the dialog header. */
    function CloseIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 4l8 8' }),
        h('path', { d: 'M12 4l-8 8' }),
      )
    }

    /** One Session menu row that raises the confirmation. */
    function PurgeSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestDelete, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      return h(
        React.Fragment,
        null,
        h('div', { className: 'session-purge-separator', 'aria-hidden': true }),
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: 'session-purge-item',
            onClick: () => {
              setMenuOpen(false)
              requestDelete(sessionId, displayTitle)
            },
          },
          h('span', { className: 'session-purge-item-icon', 'aria-hidden': true }, h(TrashIcon, null)),
          h('span', { className: 'session-purge-item-label' }, t('menu.delete')),
        ),
      )
    }

    /** The overlay entry: the confirmation surface plus the result notice. */
    function SessionPurgerOverlay({ planDelete, purgeSession, t }) {
      const request = useStoreValue(requestStore)
      const toast = useStoreValue(toastStore)
      React.useEffect(() => {
        if (toast === null) return undefined
        const timer = setTimeout(() => toastStore.set(null), 4600)
        return () => clearTimeout(timer)
      }, [toast])
      return h(
        React.Fragment,
        null,
        request === null ? null : h(SessionPurgeDialog, {
          key: request.sessionId,
          request,
          planDelete,
          purgeSession,
          t,
        }),
        toast === null ? null : h('div', { className: toast.error ? 'session-purge-toast session-purge-toast-error' : 'session-purge-toast', role: 'status' }, toast.text),
      )
    }

    /**
     * One confirmation surface. It asks the Host for a plan first, so the
     * dialog lists what actually goes — including the subagent count, which the
     * reader may drop from the same call.
     */
    function SessionPurgeDialog({ request, planDelete, purgeSession, t }) {
      const [includeSubagents, setIncludeSubagents] = React.useState(true)
      const [plan, setPlan] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const cancelRef = React.useRef(null)

      React.useEffect(() => {
        let cancelled = false
        planDelete({ sessionId: request.sessionId, includeSubagents })
          .then((result) => {
            if (cancelled) return
            if (result.ok) setPlan(result.value)
            else setFailure(result)
          })
        return () => {
          cancelled = true
        }
      }, [includeSubagents, planDelete, request.sessionId])

      const close = React.useCallback(() => {
        if (!busy) requestStore.set(null)
      }, [busy])

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [close])

      React.useEffect(() => {
        cancelRef.current?.focus()
      }, [])

      const confirm = () => {
        setBusy(true)
        setFailure(null)
        purgeSession({ sessionId: request.sessionId, includeSubagents }).then((result) => {
          setBusy(false)
          if (!result.ok) {
            setFailure(result)
            return
          }
          requestStore.set(null)
          const title = request.displayTitle === '' ? request.sessionId : request.displayTitle
          const incomplete = Array.isArray(result.value?.sessions)
            && result.value.sessions.some((entry) => Array.isArray(entry?.errors) && entry.errors.length > 0)
          if (incomplete) console.warn('session-purge: incomplete deletion', result.value)
          toastStore.set({ text: t(incomplete ? 'toast.partial' : 'toast.done', { title }), error: incomplete })
          // The move happened outside the panel, so poke the shared flag: the
          // footer count reads the bin again instead of waiting to be opened.
          binStore.set(binStore.get())
        })
      }

      const subagents = plan === null ? 0 : plan.subagentCount
      const directories = plan === null ? [] : plan.targets.flatMap((target) => target.directories)
      const title = request.displayTitle === '' ? request.sessionId : request.displayTitle

      return h(
        'div',
        { className: 'session-purge-modal', role: 'presentation' },
        h('div', { className: 'session-purge-mask', onClick: close, 'aria-hidden': true }),
        h(
          'div',
          { className: 'session-purge-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('dialog.title') },
          h(
            'div',
            { className: 'session-purge-head' },
            h('h2', { className: 'session-purge-title' }, t('dialog.title')),
            h('button', { type: 'button', className: 'session-purge-close', 'aria-label': t('dialog.close'), onClick: close }, h(CloseIcon, null)),
          ),
          h('p', { className: 'session-purge-desc' }, t('dialog.desc', { title })),
          plan === null && failure === null ? h('p', { className: 'session-purge-muted' }, t('dialog.planning')) : null,
          plan === null ? null : h(
            'div',
            { className: 'session-purge-section' },
            h('span', { className: 'session-purge-label' }, t('dialog.scope')),
            h('span', { className: 'session-purge-code' }, request.sessionId),
            subagents > 0 ? h('span', { className: 'session-purge-muted' }, t('dialog.subagents', { count: subagents })) : null,
            directories.length === 0
              ? h('span', { className: 'session-purge-muted' }, t('dialog.noDirectory'))
              : directories.map((directory) => h('span', { className: 'session-purge-code', key: directory }, directory)),
            h('span', { className: 'session-purge-note' }, t('dialog.kept')),
          ),
          plan !== null && subagents > 0
            ? h(
              'label',
              { className: 'session-purge-check' },
              h('input', {
                type: 'checkbox',
                checked: includeSubagents,
                disabled: busy,
                onChange: (event) => setIncludeSubagents(event.target.checked),
              }),
              t('dialog.subagents', { count: subagents }),
            )
            : null,
          failure === null ? null : h(
            'p',
            { className: 'session-purge-error', role: 'alert' },
            REFUSAL_KEYS[failure.code] === undefined ? failure.message : t(REFUSAL_KEYS[failure.code]),
          ),
          h(
            'div',
            { className: 'session-purge-footer' },
            h('button', { type: 'button', ref: cancelRef, className: 'session-purge-btn session-purge-btn-outline', disabled: busy, onClick: close }, t('dialog.cancel')),
            h(
              'button',
              { type: 'button', className: 'session-purge-btn session-purge-btn-danger', disabled: busy || plan === null, onClick: confirm },
              busy ? t('dialog.deleting') : t('dialog.confirm'),
            ),
          ),
        ),
      )
    }

    /** Host calls the bin surface uses; wired up in `apply`. */
    let listBin = async () => ({ ok: false, message: 'the plugin is not active yet' })
    let restoreBin = async () => ({ ok: false, message: 'the plugin is not active yet' })
    let emptyBin = async () => ({ ok: false, message: 'the plugin is not active yet' })
    let moveBin = async () => ({ ok: false, message: 'the plugin is not active yet' })
    /**
     * Drops every persisted page key naming a session the Host deleted for real;
     * assigned in `apply`. It lives here rather than inside `apply` because the
     * bin panel needs it the moment an "empty" answer arrives — that answer is
     * the only place the page ever learns those ids — and the panel is a sibling
     * of `apply`, not a child of it.
     */
    let clearPageKeys = () => 0

    /** A tiny open/closed flag the footer action and the panel share. */
    let binOpen = false
    const binListeners = new Set()
    const binStore = {
      get: () => binOpen,
      set: (value) => {
        binOpen = value
        for (const listener of binListeners) listener(value)
      },
      subscribe: (listener) => {
        binListeners.add(listener)
        return () => binListeners.delete(listener)
      },
    }

    const useBinOpen = () => {
      const [open, setOpen] = React.useState(binStore.get())
      React.useEffect(() => binStore.subscribe(setOpen), [])
      return open
    }

    /**
     * What one panel row shows.
     *
     * The Host sends the title its cache record holds, and `''` when there is
     * none (no record, unreadable head, cache unavailable). A row must never
     * render blank, so an empty title falls back to the session id; when the
     * title did take the main slot the id stays visible as the secondary line,
     * because ids are what the bin's directory tree and the Host logs speak in.
     *
     * Pure, and exported alongside `apply` for the harness (`apply`/`inject` are
     * all the module loader reads), so both directions are assertable without a
     * browser.
     *
     * @param entry - one row from the Host: `{ id, title }`.
     * @returns `{ primary, secondary }`, `secondary` null when the id is primary.
     */
    function rowLabel(entry) {
      const id = typeof entry?.id === 'string' ? entry.id : ''
      const title = typeof entry?.title === 'string' ? entry.title.trim() : ''
      return title === '' ? { primary: id, secondary: null } : { primary: title, secondary: id }
    }

    /** Sidebar-foot action: the way into the recycle bin. */
    function RecycleBinAction({ t }) {
      const open = useBinOpen()
      const [count, setCount] = React.useState(null)
      // Every bin action pokes the store, so the count re-reads after a move or a
      // restore instead of waiting for the panel to be opened again.
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => binStore.subscribe(() => setTick((value) => value + 1)), [])
      React.useEffect(() => {
        let cancelled = false
        listBin({}).then((result) => {
          if (cancelled === false && result.ok === true) setCount(result.value?.pending?.length ?? 0)
        })
        return () => {
          cancelled = true
        }
      }, [open, tick])
      const label = count === null || count === 0 ? t('bin.open') : `${t('bin.open')} (${count})`
      return h('button', {
        type: 'button',
        className: 'session-purge-item',
        title: t('bin.title'),
        onClick: () => binStore.set(open === false),
      }, [
        h('span', { key: 'icon', className: 'session-purge-item-icon' }, h('svg', {
          width: '14',
          height: '14',
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinecap: 'round',
        }, [
          h('path', { key: 'lid', d: 'M3 4.6h10' }),
          h('path', { key: 'handle', d: 'M6.1 4.6V3.3h3.8v1.3' }),
          h('path', { key: 'can', d: 'M4.7 4.6l.7 8.1h5.2l.7-8.1' }),
        ])),
        h('span', { key: 'label', className: 'session-purge-item-label' }, label),
      ])
    }

    /**
     * The bin surface: what is waiting to be deleted for real, with the two
     * actions that make sense before that happens — restore, or empty now.
     */
    function RecycleBinOverlay({ t }) {
      const open = useBinOpen()
      const [state, setState] = React.useState({ pending: [], orphans: [], error: null, busy: null, loaded: false })
      const refresh = React.useCallback(() => {
        listBin({}).then((result) => {
          if (result.ok === true) setState({ pending: result.value?.pending ?? [], orphans: result.value?.orphans ?? [], error: null, busy: null, loaded: true })
          else setState({ pending: [], orphans: [], error: result, busy: null, loaded: true })
        })
      }, [])
      React.useEffect(() => {
        if (open) refresh()
      }, [open, refresh])
      React.useEffect(() => {
        if (open === false) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') binStore.set(false)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [open])
      if (open === false) return null
      /** Whether one row's own button is the call in flight. */
      const busyOn = (action, id) => state.busy !== null && state.busy.action === action && state.busy.id === id
      const run = (endpoint, sessionId) => {
        setState((previous) => ({ ...previous, busy: { action: endpoint, id: sessionId ?? '*' } }))
        // `restore` and `move` both act on exactly one session; `empty` is the
        // whole bin unless it is handed `sessionIds`, which is how one row's
        // "delete now" skips the wait without touching the rest. `move` is the
        // same call the sidebar dialog makes, so an orphan travels the identical
        // path: into the bin now, deleted for real on the next start, restorable
        // until then.
        const call = endpoint === 'restore' ? restoreBin({ sessionId })
          : endpoint === 'move' ? moveBin({ sessionId })
            : endpoint === 'purge' ? emptyBin({ sessionIds: [sessionId] })
              : emptyBin({})
        call.then((result) => {
          // Deleting for real right now — one row or the whole bin — is what
          // takes these ids off the disk, so this answer carries the only ids the
          // page will ever see for them.
          if ((endpoint === 'empty' || endpoint === 'purge') && result?.ok === true) {
            const purged = Array.isArray(result.value?.purged) ? result.value.purged : []
            const removed = clearPageKeys(purged)
            console.info(`[session-purge] page keys: removed ${removed} key(s) after deleting ${purged.length} session(s) for real`)
          }
          refresh()
          binStore.set(binStore.get())
        })
      }
      const buttonStyle = { flex: 'none', width: 'auto', padding: '3px 10px' }
      // One row label for both sections: title first, id as the muted second
      // line, id alone when the Host had no title to send.
      const labelOf = (entry) => {
        const shown = rowLabel(entry)
        return h('span', { key: 'label', className: 'session-purge-item-label' }, shown.secondary === null
          ? shown.primary
          : [
            shown.primary,
            h('span', {
              key: 'id',
              className: 'session-purge-muted',
              style: { marginLeft: '8px', fontSize: '11px' },
            }, shown.secondary),
          ])
      }
      const rows = state.pending.map((entry) => h('div', {
        key: entry.id,
        className: 'session-purge-item',
        style: { cursor: 'default', color: 'inherit' },
      }, [
        labelOf(entry),
        // "Delete now" sits to the LEFT of Restore on purpose: the safe action
        // keeps the slot the pointer was already resting on when the panel
        // opened, and the irreversible one is a deliberate move away from it.
        h('button', {
          key: 'purge',
          type: 'button',
          className: 'session-purge-item',
          style: buttonStyle,
          disabled: state.busy !== null,
          onClick: () => run('purge', entry.id),
        }, busyOn('purge', entry.id) ? t('bin.purging') : t('bin.purge')),
        h('button', {
          key: 'restore',
          type: 'button',
          className: 'session-purge-item session-purge-safe',
          style: buttonStyle,
          disabled: state.busy !== null,
          onClick: () => run('restore', entry.id),
        }, busyOn('restore', entry.id) ? t('bin.restoring') : t('bin.restore')),
      ]))
      // Hidden subagent sessions whose parent is no longer in the session list:
      // they have no sidebar row and no dialog that names them, so this section
      // is the only way to hand one to the same two-step delete. It renders only
      // when there is something in it, so the panel stays as it was otherwise.
      const orphanRows = state.orphans.map((entry) => h('div', {
        key: entry.id,
        className: 'session-purge-item',
        style: { cursor: 'default', color: 'inherit' },
      }, [
        labelOf(entry),
        h('button', {
          key: 'move',
          type: 'button',
          className: 'session-purge-item',
          style: buttonStyle,
          disabled: state.busy !== null,
          onClick: () => run('move', entry.id),
        }, busyOn('move', entry.id) ? t('bin.orphanMoving') : t('bin.orphanMove')),
      ]))
      return h('div', { className: 'session-purge-modal', role: 'dialog', 'aria-modal': 'true' }, [
        h('div', {
          key: 'card',
          style: {
            pointerEvents: 'auto', maxWidth: '560px', margin: '12vh auto 0', padding: '16px 18px',
            borderRadius: '12px', background: 'var(--dsw-alias-bg-elevated, #1f1f1f)',
            border: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
            color: 'var(--dsw-alias-fg-default, #e8e8e8)', fontSize: '13px', lineHeight: '20px',
          },
        }, [
          h('h2', { key: 'title', style: { margin: '0 0 8px', fontSize: '15px' } }, t('bin.title')),
          h('p', { key: 'timing', className: 'session-purge-muted', style: { margin: '0 0 12px' } }, t('bin.timing')),
          state.error === null ? null : h('p', { key: 'error', className: 'session-purge-error', role: 'alert' }, state.error.message),
          state.loaded === false ? h('p', { key: 'loading', className: 'session-purge-muted' }, t('bin.loading')) : null,
          state.loaded === true && state.pending.length === 0
            ? h('p', { key: 'empty', className: 'session-purge-muted' }, t('bin.empty'))
            : null,
          h('div', { key: 'rows' }, rows),
          state.orphans.length === 0 ? null : h('div', {
            key: 'orphans',
            style: {
              marginTop: '14px', paddingTop: '12px',
              borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
            },
          }, [
            h('h3', {
              key: 'heading',
              style: { margin: '0 0 8px', fontSize: '13px', fontWeight: '600' },
            }, `${t('bin.orphans')} (${state.orphans.length})`),
            h('div', { key: 'rows' }, orphanRows),
          ]),
          h('div', { key: 'actions', style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px' } }, [
            h('button', {
              key: 'clear',
              type: 'button',
              className: 'session-purge-item',
              style: buttonStyle,
              disabled: state.busy !== null || state.pending.length === 0,
              onClick: () => run('empty'),
            }, state.busy?.action === 'empty' ? t('bin.clearing') : t('bin.clear')),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'session-purge-item',
              style: buttonStyle,
              onClick: () => binStore.set(false),
            }, t('bin.close')),
          ]),
        ]),
      ])
    }

    /** Client services this half needs before it may activate. */
    const inject = ['slots', 'locale']

    /** Register the menu row and the overlay surface. */
    function apply(ctx) {
      ctx.effect(() => insertStyles(STYLES), 'session-purge: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'session-purge: dictionaries')

      /** One call on the Host route, folded into `{ ok, value }` / `{ ok, message }`. */
      const callHost = async (endpoint, payload) => {
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint, payload }),
          })
          if (!response.ok) return { ok: false, message: `the Host route answered HTTP ${response.status}` }
          const result = await response.json()
          if (result !== null && typeof result === 'object' && result.ok === true) return { ok: true, value: result.value }
          const error = result !== null && typeof result === 'object' ? result.error : undefined
          return {
            ok: false,
            code: typeof error?.code === 'string' ? error.code : undefined,
            message: typeof error?.message === 'string' ? error.message : 'the Host refused the request',
          }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      }

      /**
       * Drop every persisted page key that names a session the Host has already
       * deleted for real. Called on two occasions: once per page load, with the
       * ids the Host purged at start-up and still holds in memory, and again
       * whenever "empty the bin" answers, with the ids it just deleted.
       */
      clearPageKeys = (ids) => {
        if (!Array.isArray(ids) || ids.length === 0) return 0
        let removed = 0
        try {
          const doomed = []
          for (let index = 0; index < window.localStorage.length; index += 1) {
            const key = window.localStorage.key(index)
            if (typeof key === 'string' && ids.some((id) => key.includes(id))) doomed.push(key)
          }
          for (const key of doomed) {
            window.localStorage.removeItem(key)
            removed += 1
          }
        } catch {
          // A browser that refuses storage is not a reason to fail activation.
        }
        return removed
      }
      // A console line rather than UI: this is diagnostic evidence, and the
      // panel should stay free of it.
      void callHost('list', {}).then((result) => {
        if (result.ok === true) {
          const purged = Array.isArray(result.value?.lastPurged) ? result.value.lastPurged : []
          const removed = clearPageKeys(purged)
          console.info(`[session-purge] page keys: removed ${removed} key(s) for ${purged.length} purged session(s)`)
        }
      })
      const requestDelete = (sessionId, displayTitle) => {
        requestStore.set({ sessionId, displayTitle: typeof displayTitle === 'string' ? displayTitle : '' })
      }

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'session-purge.delete',
        order: 500,
        locale: NS,
        inject: () => ({ requestDelete }),
      }, PurgeSessionMenuItem))

      listBin = (payload) => callHost('list', payload)
      restoreBin = (payload) => callHost('restore', payload)
      emptyBin = (payload) => callHost('empty', payload)
      moveBin = (payload) => callHost('move', payload)

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'session-purge.bin',
        order: 600,
        locale: NS,
        inject: () => ({}),
      }, RecycleBinAction))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-purge.bin-panel',
        locale: NS,
        inject: () => ({}),
      }, RecycleBinOverlay))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-purge.dialog',
        locale: NS,
        inject: () => ({
          planDelete: (request) => callHost('plan', request),
          purgeSession: (request) => callHost('move', request),
        }),
      }, SessionPurgerOverlay))
    }

    return { inject, apply, rowLabel }
  },
})
