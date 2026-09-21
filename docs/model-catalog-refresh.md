# 模型列表的解析、刷新与失效面

日期：2026-09-20
状态：**已实施并验证**（v0.4.2；`pnpm run check` 全过 + 真机 Web 端验证）
适用范围：`dsh-workbuddy-connect-oo` v0.4.2（本 fork 自有版本线）
相关：`docs/dsh-0.1.6-compat.md`（DSH 0.1.6-alpha.2 的破坏性变更）

---

## 0. 结论先行

模型列表在插件侧**只有一个加载点**（`apply()` 期间读一次本地缓存），所以"桌面 App 更新了缓存但 DSH 里看不到"是必然的。v0.4.2 加了一个手动刷新入口：**Host 重读缓存 → 换掉内存目录 → 用 `AdapterRegistrationHandle.replace()` 重发路由**，客户端收到 DSH 的 `llm/adapters-updated` 后自己重取目录 —— 不刷新页面、不重启 DSH。

---

## 1. 模型列表从哪来（整条链路）

```
浏览器选择器
  └─ ui-model-selection 的 ModelCatalogDirectory.load()
       └─ ctx.remote.session.modelCatalog()            ← Remote 调用
            └─ Host: sessionController.modelCatalog()
                 └─ buildModelCatalog(ctx)
                      ├─ ctx.llm.listProviders()       ← 活注册表
                      └─ 每个 provider: listModels() + resolveModelInfo()
```

本插件在其中的位置：`ctx.llm.registerAdapter(['workbuddy-oo'], adapter)`，adapter 的 `listModels()` 读 `WorkBuddyCatalog.current()`。

**缓存策略是客户端的事**：`ModelCatalogDirectory` 按 Host generation 只加载一次，`status === 'ready'` 时直接返回缓存值。所以即使 Host 端每次都重新 `buildModelCatalog()`，只要客户端不失效，选择器就不会变。

### 客户端何时自动失效重载

`dsh-client-ui-model-selection` 监听四个事件（`ModelCatalogDirectory` 的构造处）：

| 事件 | 动作 |
|---|---|
| `connection/reset` | `resetGeneration()`（清空 + 重载） |
| `llm/adapters-updated` | `refresh()` |
| `settings/document-updated` | `refresh()` |
| `credentials/reference-updated` | `refresh()` |

**关键**：前三个只是让客户端重新调一次 `session.modelCatalog()`；如果 Host 内存里的目录没变，调了也白调。所以要真正刷新，必须让 **Host 侧**重新读缓存，**并且**发出上述事件之一。

---

## 2. 本地缓存的来源与所有权

- 目录文件：`~/.workbuddy/cache/acc-product-config-v3.json`（可用 `ACC_PRODUCT_CONFIG_PATH` 覆盖）
- 写入方：**WorkBuddy 桌面 App 自己**（它从 `https://copilot.tencent.com/v3/config` 拉取后镜像到本地）
- 本插件：**只读**。没有网络兜底、没有静态兜底（见 AGENTS.md 的 fork 差异记录）

因此"模型变多/变新"的**前提**是桌面 App 自己刷新过那份缓存。插件重读同一份没变的文件，结果自然不变 —— 这不是 bug，是设计。`doctor` 会报缓存路径与模型条数，可用来确认这一步是否生效：

```sh
dsh-workbuddy-connect-oo doctor --json
# {"modelCatalog":{"path":".../acc-product-config-v3.json","models":33}, ...}
```

---

## 3. 手动刷新（v0.4.2）

### 3.1 Host 三步

`src/index.ts` 的 `refreshCatalog()`：

```ts
const models = await client.fetchModels()   // 1. 重读本地缓存
catalog.set([...models])                    // 2. 读成功才换掉目录
handle.replace([WORKBUDDY_PROVIDER])        // 3. 原子重发路由 → 广播事件
```

- **第 2 步的顺序是有意的**：读失败时不会执行，旧列表继续服务，选择器不会被清空。
- **第 3 步是机制核心**：`AdapterRegistrationHandle.replace()` 的实现在 `dsh-llm` 的 `commitRoutes()` 里，它是 `llm/adapters-updated` 的唯一发布点（注册与替换共用），所以"重发路由"天然等价于"通知所有客户端重取目录"。同一个 adapter 实例被保留，而它的 `listModels()` 是活读 `catalog.current()`，所以重发后答案就是新列表。

### 3.2 路由契约

`POST /plugins/dsh-workbuddy-connect/refresh-models`

```json
{"status":"ok","models":33,"readAt":1789908322481}
{"status":"error","message":"workbuddy product config cache unreadable at …"}
```

- **POST-only**：GET 返回 `405` + `Allow: POST`。否则任意页面放一个 `<img src>` 就能驱动刷新。
- **双重门禁**：要求 loopback `Origin` **和** loopback `Host`。status 路由是只读的，容忍缺 Origin；这条会改注册表状态，所以更严。缺 Host 视为不可信。
- **读失败回 200 + `status:'error'`**，不是 HTTP 错误码：失败原因要能被按钮渲染出来，而不是只显示一个状态码。
- **`models: 0` 是成功**：缓存为空是真实答案（"桌面 App 还没写过"），把它并进 error 会把最需要诊断的情况藏起来。

### 3.3 浏览器侧落位

按钮注册进 **`settings.models.provider-card`**，keyed 槽位，`key = 'workbuddy-oo'`（provider 的 settingsNs）。

这个座位由 `ui-settings-models` 在 **provider 行卡片内部** dispatch —— `renderSlot` 调用排在 `open ? renderProviderEditor(...)` 分支**之前**，所以不展开编辑器也会渲染。同一把键也会在首次配置卡与"添加提供方"草稿卡上 dispatch，无注册者时都不渲染。

> **踩过的坑**：最初放的是 `settings.models.footer`（list 槽位），结果按钮单独出现在模型页最下方，和它要刷新的 provider 分家。footer 适合"页面级"附属控件，provider 自己的控件应该用 `provider-card`。

### 3.4 类型上的处理

这里用局部窄接口（`LateDeclaredKeyedSlot`）而不是 `SlotMap` 声明合并：声明合并会和 owner 自己的声明冲突（`error TS2717: Subsequent property declarations must have the same type`）。**保留这个 cast 已不是因为类型落后** —— v0.4.3 依赖线已对齐到 `dsh 0.1.6-alpha.2`，`settings.models.provider-card` 的声明可以直接引用；现在是为了不为一个注册点额外引入 `@deepseek-ai/dsh-client-ui-settings-models` 依赖。运行时契约只是一个字符串 + `key`，代价仅是组件 props 少一层类型检查。要展开这个组件时，加依赖并去掉 cast。

---

## 4. 刷新模型数据 vs 让代码改动生效（别混）

**这是两件事。** 日常只会遇到第一件。

| 你遇到的情况 | 要做什么 | 需要 `remove`/`add` 吗 | 需要重启 DSH 吗 |
|---|---|---|---|
| **模型变了**（桌面 App 上架/下架/改价） | 点「刷新模型列表」按钮 | **不需要** | **不需要** |
| 改了插件**源码**（开发者场景） | `tsdown` → `remove` → `add` → 再刷新页面或重载插件 | 需要（`file:` 是复制，不重装跑的是旧代码） | 改 Host 侧要，只改客户端不用 |

### 4.1 只刷新模型数据

点按钮即可。它的作用范围**仅限**「重读缓存文件 + 重发路由」，不加载任何新代码 —— 所以插件是 0.4.0 还是 0.4.2，按钮行为都一样。

不想要按钮也可以：重载插件或重启 DSH 都会重新 `apply()`，而 `apply()` 里本来就会读一次缓存，所以**它们同样能把模型刷新到最新**（只是顺带做了很多别的事，代价大得多）：

| 手段 | 能刷新模型吗 | 代价 |
|---|---|---|
| 点刷新按钮 | 能 | 一键 |
| 插件面板开关关掉再打开 | 能（`apply()` 重跑） | 会写 `cordis.patch.yml`；依赖 HMR，没开 HMR 的 profile 会提示需要重启 |
| 重启 DSH | 能 | 最彻底最重 |

### 4.2 让代码改动生效

只有改了仓库里的 `.ts` 才需要。用仓库里的脚本：

```sh
node scripts/reinstall-local.mjs          # 默认 web，可传 desktop / dsh-tui
```

它做五件事：构建 → `remove`+`add` → 恢复 `dsh.profile.bundles` 顺序 → 逐字节校验副本 → 报告该刷新页面还是重载插件。**别手敲 `add`**：pnpm 对本地目录依赖不记内容哈希，`add`、`add --force`、`update`、`install --force` 全是空操作，只有 `remove` 再 `add` 会重写副本（四个命令的实测记录见 [`AGENTS.md`](../AGENTS.md) 的部署说明）。

**只改客户端包（`lib/client.js`）时不需要重启**：DSH 的 client-modules 会在插件包变化后重新下发 bundle（boot payload 里的 `rev` 会变），刷新页面即可。**改了 Host 侧代码才需要重载插件或重启 DSH。** 脚本会比对安装前后的 `lib/index.js` 与 `lib/client.js` 哈希，直接把该做哪一步打出来。

---

## 5. 验证方式

| 层 | 覆盖 |
|---|---|
| `tests/web-refresh.spec.ts` | 路由门禁（非 POST→405+Allow、跨站 Origin→403、非回环 Host→403）与两种返回形状 |
| `tests/refresh-integration.spec.ts` | 真 cordis 树 + 真 `LlmRuntime`：改写缓存文件 → POST → 断言 `llm/adapters-updated` 真的又发一次、且 `ctx.llm.listModels('workbuddy-oo')` 返回新列表；第二个用例断言读失败时旧列表继续服务 |
| 真机 | Web 端 设置 → 模型 → WorkBuddy 卡片内点按钮 → 「已刷新：33 个模型」 |

集成测试是这一层的重点：单元测试只能证明"路由被调用了"，而 `replace()` 到底有没有真的重播事件、注册表有没有开始回答新列表，只有跑真注册表才能证明。

---

## 6. 排查清单

模型列表不更新时按顺序看：

1. `doctor --json` 的 `modelCatalog.models` —— 缓存文件本身是不是新的？不是 → 去桌面 App 那边让它刷新。
2. 插件是否已加载新代码：`GET .../refresh-models` 返回 **404** 说明 Host 侧路由未注册（旧代码在跑），需要重载/重启。
3. 点按钮后返回什么：
   - `{status:'error'}` → 缓存读不到，看 `message`（通常是文件被删/换位置/权限）。
   - HTTP **403** → 回环门禁拒绝：当前不是通过 `127.0.0.1` / `localhost` 访问（隧道、桌面壳用了别的主机名）。
   - HTTP **405** → 请求不是 POST。注意：POST 到**未注册**的路径也会是 405（DSH 静态兜底对非 GET/HEAD 一律 405，且响应体为空），用来区分"路由没注册"看响应体有没有 `{"error":"method not allowed"}`。
4. 按钮点了但选择器没变 → 看浏览器控制台有没有 `llm/adapters-updated` 到达；理论上不需要手动刷新页面。
