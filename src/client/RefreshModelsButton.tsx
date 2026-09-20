/**
 * Model-page footer button: re-read the WorkBuddy model cache on demand.
 *
 * The picker's catalog is cached per Host generation by the client, and the
 * Host answers `session.modelCatalog()` from the live LLM registry, so a list
 * that changed on disk (the desktop app rewrote its product-config cache)
 * stays invisible until something re-reads it. This button drives the Host
 * route that does both halves — re-read the cache, then republish the
 * provider's routes — and DSH's own `llm/adapters-updated` handler takes care
 * of the rest. No reload, no DSH restart.
 *
 * It lives in the Models settings page's footer slot because that is where a
 * user looking at the model list already is, and because it is the plugin's
 * only browser surface: the account/credit card this plugin used to ship
 * registered into `settings.plugin.item`, which DSH 0.1.6-alpha.2 removed.
 *
 * @module dsh-workbuddy-connect/client/RefreshModelsButton
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { WORKBUDDY_REFRESH_PATH } from '../status-paths.ts'
import type { WorkBuddyWebRefreshResult } from '../status-paths.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface WorkBuddyRefreshInjected {
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
}

/** Props of the model-page footer button. */
export type RefreshModelsButtonProps = Partial<WorkBuddyRefreshInjected>

/** What the last completed refresh reported. */
type RefreshOutcome =
  | { kind: 'idle' }
  | { kind: 'ok'; models: number }
  | { kind: 'error'; message: string }

const wrapStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 12,
  padding: '4px 0',
}

const textStyle: CSSProperties = {
  display: 'flex',
  minWidth: 0,
  flexDirection: 'column',
  gap: 3,
  flex: '1 1 260px',
}

const titleStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: '20px',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

const hintStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
}

const buttonStyle: CSSProperties = {
  boxSizing: 'border-box',
  minHeight: 34,
  padding: '6px 14px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 18,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 14,
  cursor: 'pointer',
}

const busyButtonStyle: CSSProperties = {
  ...buttonStyle,
  cursor: 'default',
  color: 'var(--dsw-alias-label-tertiary)',
}

const outcomeStyle: CSSProperties = {
  flexBasis: '100%',
  margin: 0,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-state-success-primary, #22a06b)',
}

const errorOutcomeStyle: CSSProperties = {
  ...outcomeStyle,
  color: 'var(--dsw-alias-state-error-primary, #d92d20)',
}

/** Render the outcome line, or nothing before the first refresh. */
function outcomeText(outcome: RefreshOutcome, t: WorkBuddyRefreshInjected['t']): string | undefined {
  if (outcome.kind === 'ok') {
    return outcome.models === 0 ? t('refreshModelsOkEmpty') : t('refreshModelsOk', { count: outcome.models })
  }
  if (outcome.kind === 'error') return t('refreshModelsFailed', { message: outcome.message })
  return undefined
}

/**
 * One button that re-reads the WorkBuddy model cache and republishes it.
 * @param props - the registration's injected translate seat.
 * @returns the footer row, or nothing when copy is missing.
 */
export function RefreshModelsButton({ t }: RefreshModelsButtonProps): React.ReactNode {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<RefreshOutcome>({ kind: 'idle' })
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    // The seat is required for every message this action reports; without it
    // there is no button to press either (see the early return below).
    if (t === undefined) return
    setBusy(true)
    try {
      const response = await fetch(WORKBUDDY_REFRESH_PATH, {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      // The route answers 200 for a failed read too (the reason rides the
      // document), so a non-OK status means the route itself refused — most
      // often the loopback gate, which a desktop shell or tunnel reached under
      // another host name will hit. That case gets its own actionable line
      // instead of a bare status code.
      if (response.status === 403) {
        if (mounted.current) setOutcome({ kind: 'error', message: t('refreshModelsForbidden') })
        return
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json() as WorkBuddyWebRefreshResult
      if (!mounted.current) return
      setOutcome(value.status === 'ok'
        ? { kind: 'ok', models: value.models }
        : { kind: 'error', message: value.message })
    } catch (error: unknown) {
      if (!mounted.current) return
      setOutcome({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [t])

  if (t === undefined) return null

  const detail = outcomeText(outcome, t)
  return (
    <div style={wrapStyle}>
      <div style={textStyle}>
        <span style={titleStyle}>{t('refreshModels')}</span>
        <span style={hintStyle}>{t('refreshModelsHint')}</span>
      </div>
      <button
        type="button"
        style={busy ? busyButtonStyle : buttonStyle}
        disabled={busy}
        aria-label={t('refreshModels')}
        onClick={() => {
          void refresh()
        }}
      >
        {busy ? t('refreshModelsBusy') : t('refreshModels')}
      </button>
      {detail === undefined ? null : (
        <p
          style={outcome.kind === 'error' ? errorOutcomeStyle : outcomeStyle}
          role="status"
        >
          {detail}
        </p>
      )}
    </div>
  )
}
