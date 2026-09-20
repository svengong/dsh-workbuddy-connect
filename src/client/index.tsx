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
 * The Models settings page's footer slot: `kind: 'list'`, `scope: 'root'`,
 * declared by DSH's own `ui-settings-models` ("without a registrant the area
 * renders nothing").
 */
const MODELS_FOOTER_SLOT = 'settings.models.footer'

/**
 * The slice of the slot service this registration needs.
 *
 * Typed locally rather than through `SlotMap`: this package's pinned DSH types
 * predate the footer slot, and declaring the key in the shared table would
 * collide with the owner's own declaration — "subsequent property declarations
 * must have the same type" — as soon as those dependencies move to the 0.1.6
 * line. The wire contract is small and stable: a list slot takes `id` (the
 * cell) plus `order`, and an `inject` factory supplies the component's extra
 * props.
 */
interface LateDeclaredListSlot {
  inject: (name: string, register: () => () => void) => () => void
  register: (
    options: { name: string; id: string; order?: number; inject: () => WorkBuddyRefreshInjected },
    component: unknown,
  ) => () => void
}

/** Stable browser-plugin name. */
export const name = 'dsh-workbuddy-connect-client'
/** Client services required by the Plugin configuration contribution. */
export const inject = ['slots', 'locale']

/**
 * Register the model-refresh copy and the Models page's footer control.
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
    // The Models page's footer: the refresh control sits where the user is
    // already looking at the served models. It is the plugin's only browser
    // surface — the account/credit card this plugin used to ship registered
    // into `settings.plugin.item`, which DSH 0.1.6-alpha.2 removed, so a
    // registration there would never render again.
    const lateSlots = ctx.slots as unknown as LateDeclaredListSlot
    lateSlots.inject(MODELS_FOOTER_SLOT, () => lateSlots.register({
      name: MODELS_FOOTER_SLOT,
      id: 'workbuddy-oo-refresh-models',
      order: 30,
      inject: (): WorkBuddyRefreshInjected => ({ t }),
    }, RefreshModelsButton))
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-workbuddy-connect] client card failed to load (host provider unaffected):', error)
  }
}
