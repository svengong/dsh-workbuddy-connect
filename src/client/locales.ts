/**
 * Copy for the plugin's browser surface, registered under the
 * `settings.workbuddy` locale namespace.
 *
 * Only the manual model refresh lives here. The account/credit card this
 * namespace used to carry was retired with DSH 0.1.6-alpha.2, which removed the
 * `settings.plugin.item` slot it registered into; its copy went with it, and
 * `git log -- src/client/WorkBuddyPluginCard.tsx` has the rest.
 */

export const en = {
  refreshModels: 'Refresh model list',
  refreshModelsBusy: 'Refreshing…',
  refreshModelsHint: 'Re-reads the WorkBuddy desktop app\'s local model cache and republishes the provider, so the picker updates without restarting DSH.',
  refreshModelsOk: 'Refreshed: {count} models',
  refreshModelsOkEmpty: 'Refreshed, but the cache lists no models',
  refreshModelsFailed: 'Refresh failed: {message}',
  refreshModelsForbidden: 'Refresh refused: it must come from a loopback address (127.0.0.1 / localhost).',
} as const

export type WorkBuddySettingsKey = keyof typeof en

export const zh: Record<WorkBuddySettingsKey, string> = {
  refreshModels: '刷新模型列表',
  refreshModelsBusy: '正在刷新…',
  refreshModelsHint: '重新读取 WorkBuddy 桌面 App 的本地模型缓存并重新发布模型，选择器立即更新，无需重启 DSH。',
  refreshModelsOk: '已刷新：{count} 个模型',
  refreshModelsOkEmpty: '已刷新，但缓存里没有模型',
  refreshModelsFailed: '刷新失败：{message}',
  refreshModelsForbidden: '刷新被拒绝：该请求必须来自本机回环地址（127.0.0.1 / localhost）。',
}
