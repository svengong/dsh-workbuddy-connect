# 在 DSH 0.1.6-alpha.2 上运行（类型仍锁 0.1.2-alpha.5）

日期：2026-09-20
状态：**真机验证可运行**（Web 端，DSH `0.1.6-alpha.2`）
适用范围：`dsh-workbuddy-connect-oo` v0.4.2

---

## 0. 为什么会有这份文档

本包 peer 锁在 `dsh 0.1.2-alpha.5` 一代，而实际运行的 DSH 是 `0.1.6-alpha.2`。**运行时能跑**，但类型层与运行时的偏差会持续制造"编译过了、行为不对"的陷阱（比如槽位注册成功但永远不渲染）。这里集中记录已知的偏差与处理原则，避免下一轮重新踩。

---

## 1. 已验证的运行时事实（0.1.6-alpha.2）

| 事实 | 证据 |
|---|---|
| Host 半部正常：provider 注册、模型目录、`/v1/*` shim 都工作 | 模型选择器显示 WorkBuddy 组 33 个模型 |
| `ctx.llm.registerAdapter` 返回的 handle 有 `replace()` | 手动刷新链路可用（见 `docs/model-catalog-refresh.md`） |
| 槽位注册 spec **同时接受** `key`/`priority` 与 `id`/`order` | `dsh-client-ui-slots` 的 `StoredEntry.options` 两种字段都在 |
| `settings.models.provider-card`（keyed）与 `settings.models.footer`（list）都存在 | `ui-settings-models` 的 slot-contract 里已声明 |

---

## 2. 已确认的破坏性变更

### 2.1 `settings.plugin.item` 槽位被移除

**症状**：注册进该槽位的设置卡片在 0.1.6 上**永远不渲染**，而且**不报错** —— `ctx.slots.inject()` 只是等一个永不到来的声明。

**本仓库的处理（v0.4.2）**：把原来的账号/积分状态卡片整个删掉，不再迁移。理由是当时唯一需要的浏览器能力是刷新按钮，而刷新按钮更适合放在模型页的 provider 行里（`settings.models.provider-card`）。历史实现见 `git log -- src/client/WorkBuddyPluginCard.tsx`。

**如果以后要把账号/积分卡片找回来**：注册到 `plugins.item`（0.1.6 的内置插件页新座位），不要再用 `settings.plugin.item`。

> 生态旁证：`cheshireez/dsh-skill-hub` v0.3.14 的更新说明记录了同一条变更（"dsh `0.1.6-alpha.2` 移除了 `settings.plugin.item` slot，配置卡片改注册到 `plugins.bundle.config`"）。

### 2.2 `SessionListState.current` 被移除（本插件未使用，但同类风险）

0.1.6 的会话列表快照只剩 `ids / byId / phase / subagentsByParent / jobsBySession`，"当前会话"迁到了 `uiWorkspace` 的 selection store。任何读 `ctx.sessions.list.getSnapshot().current` 的插件在 0.1.6 上会**静默拿到 `undefined`**。

本插件的 `web-status.ts` 用的是 `deps.store.status()` 与心跳文件，不读会话列表，因此不受影响。记录在此是为了说明这类"字段消失 → 静默 undefined"是 0.1.6 的一条固定失效模式：**合上游或改依赖时，凡是读 DSH 快照字段的地方都要核对。**

---

## 3. 类型偏差的处理原则

**不要用 `SlotMap` 声明合并去补 0.1.6 的槽位。** 本包类型里没有 `settings.models.provider-card`，但声明合并会在依赖升到 0.1.6 线与 owner 自己的声明冲突：

```
error TS2717: Subsequent property declarations must have the same type.
```

**采用的做法**：局部窄接口描述真正用到的那一小块契约（`LateDeclaredKeyedSlot`），槽位名与 key 用字符串常量。运行时契约本来就只是一个字符串 + `key`，副作用是组件 props 少一层类型检查 —— 对"一个按钮 + 一行文案"的规模是合适的取舍。

完整例子见 `src/client/index.tsx`。

---

## 4. 升依赖时的检查清单

真要升到 0.1.6 类型线时，按顺序确认：

1. `settings.models.provider-card` / `plugins.item` 的声明形状，删掉对应的 `LateDeclared*` 窄接口；
2. `ctx.llm.registerAdapter` 的 handle 类型（`AdapterRegistrationHandle` 的 `replace` 是否仍在，是否新增了别的方法）；
3. `dsh-client-ui-*` 的 slot 注册 spec 字段（`key`/`priority` vs `id`/`order`）；
4. `dsh-settings` 的 `installSection` 签名（0.1.2-alpha.5 已把 `installSettingsSection()` 换成服务方法，别再回退）；
5. `dsh-llm-pi-ai` 的 profile 类型字段（上游 v0.3.2 为 0.1.5 补过 `modelErrors`，本 fork 尚未跟进）。
