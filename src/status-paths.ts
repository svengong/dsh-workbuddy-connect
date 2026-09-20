/** Node-free constants and types shared by the Host and browser halves. */

/** Plugin-owned status endpoint consumed by its browser half. */
export const WORKBUDDY_STATUS_PATH = '/plugins/dsh-workbuddy-connect/status'

/**
 * Plugin-owned model-refresh endpoint consumed by its browser half.
 *
 * A separate path from the status document because this one changes registry
 * state: it re-reads the local product-config cache and republishes the
 * provider's routes, which is what makes DSH re-read the model catalog. It is
 * therefore POST-only and gated on a loopback Host as well as a loopback
 * Origin, so a cross-origin page cannot drive it.
 */
export const WORKBUDDY_REFRESH_PATH = '/plugins/dsh-workbuddy-connect/refresh-models'

/** One billing package and its remaining credit. */
export interface WorkBuddyWebCreditAccount {
  packageName: string
  remain: number
  size: number
}

/** Aggregated credit answer rendered by the plugin card. */
export interface WorkBuddyWebCredits {
  total: number
  accounts: readonly WorkBuddyWebCreditAccount[]
}

/** Billing convenience facts for one model, rendered as card badges. */
export interface WorkBuddyWebModelBadge {
  id: string
  name: string
  /** Whether the model is currently free (`x0.00` credits). */
  free?: boolean
  /** Promotional badges, e.g. `限时免费`, `夜间折扣`. */
  badges?: readonly string[]
  /**
   * Credits multiplier in display form, e.g. `x0.79`. Unlike the model
   * picker's copy, the card renders through the browser locale, so this value
   * may be interpolated into a localized sentence rather than shown bare.
   */
  credits?: string
}

/**
 * The JSON answer of one manual model refresh.
 *
 * `models: 0` is a success, not a failure: an empty cache is a real answer
 * ("the desktop app has not written one"), and collapsing it into an error
 * would hide the one case the button exists to diagnose.
 */
export type WorkBuddyWebRefreshResult =
  | {
    status: 'ok'
    /** Models the picker serves after the swap. */
    models: number
    /** Epoch milliseconds of the read, so the button can show how fresh it is. */
    readAt: number
  }
  | { status: 'error'; message: string }

/** The JSON document the plugin card renders. */
export type WorkBuddyWebStatus =
  | {
    status: 'signed-out'
    /**
     * Why the stored sign-in is unusable when that is diagnosable — e.g. the
     * desktop app sealed the credential at rest. The card renders it verbatim
     * inside a localized sentence, because the host seam has no locale service.
     */
    reason?: string
  }
  | {
    status: 'signed-in'
    nickname?: string
    domain?: string
    source?: 'desktop' | 'desktop-unlocked' | 'dsh'
    expiresAt?: number
    credits?: WorkBuddyWebCredits
    creditsError?: string
    /** Billing convenience facts for the models the plugin serves. */
    models?: readonly WorkBuddyWebModelBadge[]
  }
  | { status: 'error'; message: string }
