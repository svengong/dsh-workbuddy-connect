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
5. `dsh-llm-pi-ai` 的 profile 字段 `modelErrors`（**已修**，见第 6 节；但编译所用的类型仍缺，所以本地交叉类型要保留）。

---

## 5. 运行时升级会留下一份陈旧的共享模块农场

**现象**：`~/.dsh/profiles/node_modules/@deepseek-ai/*`（约 460 个软链）指向 `runtime/npm0.1.6-alpha.1`，而活动运行时是 `runtime/current → npm0.1.6-alpha.2`。

**根因是 DSH 自己的行为变更**，不是本仓库的问题。`dsh/lib/profile-boot-*.js` 的 `runProfile`：

| runtime | 默认 `resolutionMode` | 磁盘软链 |
|---|---|---|
| 0.1.6-**alpha.1** | `options.resolutionMode ?? "link"` | **会写**（`healProfilesModuleFallback`，materialize = true） |
| 0.1.6-**alpha.2** | `options.resolutionMode ?? "runtime"` | **不写**（`createProfileResolutionGeneration`，只读） |

alpha.1 默认以 `link` 模式启动，所以农场是它建的；alpha.2 把默认改成 `runtime` 后就不再维护它 —— 升级时既没有迁移也没有清理，留下一份指向旧 runtime 的农场。

**运行中的 host 不受影响**：`runtime` 模式下 `dsh-app-boot/lib/worker/profile-resolution-bootstrap.js` 会给 Node 的 ESM/CJS 加载器打补丁，按计算出的 generation（当前 runtime）路由；遍历 `createRequire(parent).resolve.paths()` 时**遇到 `generation.shared`（即 profiles 目录）就 `break`**，即软链农场被刻意排除在候选之外。所以共享包名一律走当前 runtime。

**但陈旧的农场仍会误导**：编辑器、独立的 `node` 进程、以及任何以 `link` 模式启动的进程都按磁盘解析，看到的是旧 runtime。

> **诊断陷阱（我踩过）**：在独立 node 进程里 `createRequire(...).resolve('@deepseek-ai/dsh-llm')` 走的是**磁盘**，没有内存路由，所以它显示旧 runtime —— **不能据此断定运行中的 host 加载了旧库**。要判断 host 实际用哪个版本，看它发的前端产物（`/` 里的 `assets/index-*.js` 名与各 runtime 的 `dsh-web-frontend/dist/index.html` 对照），那才是进程自身的版本。

**怎么查**：

```sh
readlink ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm   # 农场的指向
readlink ~/.dsh/runtime/current                              # 活动 runtime
```

**怎么修**：用 `dsh-app-boot` 自己的物化函数重指（等价于以 `link` 模式启动一次）：

```js
const { healProfilesModuleFallback } = await import(
  `${DSH_HOME}/runtime/current/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`)
await healProfilesModuleFallback({
  installAnchor: `${DSH_HOME}/runtime/current/node_modules/@deepseek-ai/dsh/package.json`,
  home: DSH_HOME,
  materialize: true,
})
```

它内部按 `readlinkSync(link) === entry.packageDir` 判定是否需要重写，所以只在真的过期时才动。（同一函数在 `resolutionMode: "link"` 的启动路径上会被自动调用。）**下次升级 runtime 后还会再陈旧一次** —— alpha.2 起的默认模式不维护农场，这是上游该修的地方。

---

## 6. `modelErrors`：一个只在运行时才炸的必填字段（已修）

**症状**：模型选择器里 WorkBuddy 整组变成

```
WorkBuddy 加载失败：Cannot read properties of undefined (reading 'get')
```

33 个模型一个都选不了。而「刷新模型列表」按钮照旧报成功 —— 它只统计从缓存解析出的条数，不经过这条路径，所以两条信息看起来自相矛盾，很容易误判成刷新把状态弄坏了。

**根因**：`dsh-llm-pi-ai` 0.1.5+ 在 `modelOf()` 里逐次读取

```js
const failure = profile.modelErrors.get(model) ?? …
```

（0.1.6-alpha.1 与 alpha.2 都有，同一行号。）而本插件自己构造那份 profile（`src/adapter.ts`），**从未提供 `modelErrors`** → `undefined.get` 抛错 → `buildModelCatalog` 按 provider 捕获，把整组换成 `failures` 条目。上游 v0.3.2 已为 DSH 0.1.5 修过同一条，本 fork 当时没跟进。

**修法**：profile 补 `modelErrors: new Map()`（空 Map 是正确值：这些描述符由本适配器在构造期就把问题暴露出来，不存在"个别模型坏掉"的延迟状态）。本包编译所用的 `0.1.2-alpha.5` 类型里**没有这个字段**，因此用一个本地交叉类型 `ProfileWithModelErrors` 加上，而不是去改共享类型。

**为什么既有测试一条都没发现（重要教训）**：仓库的 devDependency 仍是 `0.1.2-alpha.5`，而那一版的 `modelOf()` **根本不读** `modelErrors` —— 同一份代码在测试里完好，在宿主上炸掉。这类"宿主库比编译库新"的要求，**离线测试从原理上覆盖不到**。能用的两道防线：
- **结构性断言**：`tests/settings-integration.spec.ts` 直接检查注册表里那份 profile 带 `modelErrors` 且为空 Map（已验证：去掉修复行该断言会失败）；
- **真机检查**：每次升级 DSH 运行时后，看一眼选择器里每一组是否都能展开 —— `doctor` 和离线测试都看不到 `failures`。

**同类风险**：凡是本插件"自己构造对象交给宿主库"的地方（`ResolvedPiAiProviderProfile`、交给 `ctx.llm.registerAdapter` 的 adapter 形状、settings section 描述符），宿主库新增必填字段都会以这种静默方式失效。升级运行时后按第 4 节清单逐项核对。
