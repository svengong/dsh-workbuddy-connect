/** Browser half: the manual model-refresh control on the Models settings page. */

// `dsh-client-*` 0.1.2-alpha.5 retired the `dsh-client-runtime` package: the
// browser plugin context is cordis' own `Context` now, and the services it
// carries come from the packages that own them. `locale` rides on
// `dsh-client-locale`, `slots` on the renderer — both type-only, since at
// runtime the platform's own client modules provide them.
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { RefreshModelsButton } from './RefreshModelsButton.tsx'
import type { WorkBuddyRefreshInjected } from './RefreshModelsButton.tsx'
import { en, zh } from './locales.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Model-refresh copy for the plugin's Models-page control. */
    'settings.workbuddy': WorkBuddySettingsKey
  }
}

/**
 * The seat for a provider's own extra card, keyed by that provider's settings
 * namespace — `workbuddy-oo` here.
 *
 * The Models page dispatches it on the provider's row card itself, before and
 * independently of that row's editor (`ui-settings-models` renders the
 * `renderSlot` call ahead of its `open ? editor` branch), so an occupant lands
 * INSIDE the WorkBuddy card instead of in a detached area at the page's end.
 * The same key is dispatched on the first-run setup card and the add-provider
 * draft card; all three render nothing without a registrant.
 */
const PROVIDER_CARD_SLOT = 'settings.models.provider-card'

/** This provider's key in that keyed slot: its settings namespace. */
const PROVIDER_CARD_KEY = 'workbuddy-oo'

/**
 * The slice of the slot service this registration needs.
 *
 * Typed locally rather than through `SlotMap`: this package's pinned DSH types
 * predate the seat, and declaring the key in the shared table would collide
 * with the owner's own declaration — "subsequent property declarations must
 * have the same type" — as soon as those dependencies move to the 0.1.6 line.
 * The wire contract is small and stable: a keyed slot takes `key` (the cell),
 * and an `inject` factory supplies the component's extra props.
 */
interface LateDeclaredKeyedSlot {
  inject: (name: string, register: () => () => void) => () => void
  register: (
    options: { name: string; key: string; priority?: number; inject: () => WorkBuddyRefreshInjected },
    component: unknown,
  ) => () => void
}

/** Stable browser-plugin name. */
export const name = 'dsh-workbuddy-connect-client'
/** Client services required by the Plugin configuration contribution. */
export const inject = ['slots', 'locale']

/**
 * Register the model-refresh copy and the control inside the WorkBuddy card.
 *
 * The entire body is wrapped so that a DSH slot-API breaking change (for
 * example the rc.6→rc.7 `id`→`key` / `order`→`priority` rename) degrades
 * to a `console.error` instead of throwing into the DSH loader and raising
 * the red "Failed to load plugins" banner. The host provider keeps working:
 * the `workbuddy` model channel is unaffected, and `dsh-workbuddy-connect
 * status` reports host health via the heartbeat file.
 *
 * NOTE: the try/catch boundary of this function is mirrored (duplicated) in
 * `tests/client-fallback.spec.ts`, because the real client entry imports
 * browser-only DSH packages that cannot load in the Node test environment.
 * That test therefore does not import this function — it replicates its
 * shape. If you change the guarded body or the `console.error` message here,
 * update the mirrored `apply()` in that spec too, or the fallback test will
 * silently diverge from this real implementation.
 */
export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.workbuddy'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy-connect: settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyRefreshInjected['t']
    // Inside the WorkBuddy provider row on the Models page. This is the
    // plugin's only browser surface: the account/credit card it used to ship
    // registered into `settings.plugin.item`, which DSH 0.1.6-alpha.2 removed,
    // so a registration there would never render again.
    const lateSlots = ctx.slots as unknown as LateDeclaredKeyedSlot
    lateSlots.inject(PROVIDER_CARD_SLOT, () => lateSlots.register({
      name: PROVIDER_CARD_SLOT,
      key: PROVIDER_CARD_KEY,
      priority: 30,
      inject: (): WorkBuddyRefreshInjected => ({ t }),
    }, RefreshModelsButton))
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-workbuddy-connect] client card failed to load (host provider unaffected):', error)
  }
}
