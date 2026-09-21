# dsh-workbuddy-connect Agent Notes

## 仓库定位：本地 git，无远程

本仓库自 v0.4.2 起**只维护本地 git**：不推送、不发布、不与上游同步。原 `fork`（svengong）与 `origin`（corrinehu 上游）两个 remote 已删除，`AGENTS.md` 里过去的"合上游流程"不再适用。

- **不要 `npm publish`、不要打 release tag、不要 `git push`**，除非用户明确要求。
- 版本号是本 fork **自己的线**，与上游不共享。已知历史撞号：本仓库的 `v0.3.0`（`f7671da`）与 `v0.4.0`（`36e27e4`）与上游同名 tag 指向**不同提交**。后续升版本请避开上游已用过的号段，或改用带后缀的形式。
- **部署方式：本地路径安装**（`file:/Users/sven/workspace/dsh-workbuddy-connect`）。`package.json` 已标 `"private": true`，且不再有 `repository`/`bugs`/`homepage` 字段。
  - **pnpm 的 `file:` 依赖是复制，不是软链**：装完后 `profiles/web/node_modules/dsh-workbuddy-connect-oo/` 是本仓库的一份**实体副本**（普通文件，`links=1`）。改 `src/` 或 `lib/` 都不会影响已安装的副本。
  - **只重跑 `add` 不会刷新副本**（2026-09-21 实测）：lockfile 里记的是 `resolution: {directory: …, type: directory}`，pnpm 认定这个目录依赖已解析就直接跳过，`add` 与 `add --force` 都不重写副本，输出只有 `Packages: -2` / `Already up to date`。**必须 `remove` 再 `add`**：
    ```sh
    cd /Users/sven/workspace/dsh-workbuddy-connect && node_modules/.bin/tsdown
    cd /Users/sven/.dsh/profiles/web
    dsh plugin --profile web remove dsh-workbuddy-connect-oo
    dsh plugin --profile web add file:/Users/sven/workspace/dsh-workbuddy-connect
    ```
  - **副作用：`remove`/`add` 会把 `dsh.profile.bundles` 里的顺序改成把本插件排到最后。** 加载顺序对本插件无影响（它只依赖 `dsh-base` 提供的 `llm`，而 `dsh-base` 排在最前），但会留下一个非预期的 diff；要消除就手动把 `dsh-workbuddy-connect-oo` 挪回原位。
  - **生效范围**：只改客户端包（`lib/client.js`）时刷新页面即可（DSH 会重新下发 bundle）；改了 Host 侧代码需要重载插件或重启 DSH。见 [`docs/model-catalog-refresh.md`](docs/model-catalog-refresh.md) 第 4 节。
  - 安装形态变更史：v0.4.2 之前是 `github:` 固定 commit pin（`svengong/dsh-workbuddy-connect#<sha>`），随远程断开而废弃。

## 待办

- 无。上游 PR 追踪已随远程断开而终止。

## 本 fork（-oo）与上游的差异

本仓库是 `dsh-workbuddy-connect-oo`，相对上游 corrinehu/dsh-workbuddy-connect 的独立演进。以下偏离是**设计决定**，不是待办：

- **插件身份**：包名 `dsh-workbuddy-connect-oo`，provider 路由 `workbuddy-oo`，bin 名 `dsh-workbuddy-connect-oo`；与上游插件可并存不冲突。
- **模型目录只读本地缓存**（`7d10f7b` 起）：`fetchModels()` 只读 `~/.workbuddy/cache/acc-product-config-v3.json`（`ACC_PRODUCT_CONFIG_PATH` 可覆盖，无需凭据），**没有网络兜底、没有静态兜底**——读不到就服务空目录并记日志。
  - 目的：插件列表永远不会和桌面 App 自己显示的不一致（上游是"网络为主 + 静态兜底"，两者会出现漂移）。
  - 代价：**缓存过期时只能靠桌面 App 刷新 + 手动触发重读**，见 `docs/model-catalog-refresh.md`。
  - `src/catalog.ts` 的 `FALLBACK_WORKBUDDY_MODELS` 仅作为公开导出与诊断资料保留，运行时不再初始化用它。
  - 上游对模型字段的解析改动（`supportsImages`、reasoning/billing）现在集中在本 fork 的解析器里；引用上游实现时注意其网络解析分支与本仓库的本地解析分支是**两处**，不要只改一处。
- **推理强度透传**：`src/adapter.ts` 按三优先级解析档位（后端 `supportedEfforts` → 内置 `BUILTIN_THINKING_LEVEL_MAP` → 固定 `effort` 单档），并带 `deepseek -ioa` 档位补全。v0.3.1 合并上游 v0.2.6 后的语义：**声明集模型**恰好暴露声明的档位——`off` 亦然，它必须由上游 `supportedEfforts` 声明，`canDisableThinking` 无权单独授权（否则每次默认请求都会发 `reasoning_effort:"off"` 被上游 400 拒绝，见「未发布修复」）；**旧形态模型**（`{effort, summary}`，无声明集）保留本 fork 的单档策略——只暴露默认 effort 一档（上游 v0.2.6 是完全不暴露控件；其 alpha 分支实测旧形态上游接受完整档位集 low/medium/high/xhigh/max 全 200，但桌面端对旧形态模型逐模型区别显示控件，可选集是客户端私有知识，单档是「暴露控件但只给安全值」的折中）。
- **上游请求身份**：UA 用 `WorkBuddy/5.3.14` 并附 `X-IDE-*` 头；按 `enterpriseId` 走企业模型端点。

## 未发布改动

- 无。工作树与 `main` 一致时即代表当前版本就是全部内容。

## 最近发布

- **v0.4.2（2026-09-20）**：刷新按钮落位修正 —— 从 `settings.models.footer`（list）改到 `settings.models.provider-card`（keyed，`key='workbuddy-oo'`），按钮现在显示在「设置 → 模型」的 WorkBuddy 卡片**内部**，不再单独落在页面底部。机制与契约见 [`docs/model-catalog-refresh.md`](docs/model-catalog-refresh.md)。**未打 tag。**

- **v0.4.1（2026-09-20）**：模型页新增「刷新模型列表」（Host 重读缓存 + `AdapterRegistrationHandle.replace()` 重发路由，客户端凭 `llm/adapters-updated` 自行重取目录，无需重启 DSH）；同时删掉注册在 `settings.plugin.item` 的账号/积分卡片——该槽位在 DSH `0.1.6-alpha.2` 已移除，卡片永远不会渲染。新增 `tests/web-refresh.spec.ts`（路由门禁与返回形状）与 `tests/refresh-integration.spec.ts`（真 `LlmRuntime` 验证 `replace()` 确实重播事件、注册表开始回答新列表）。**未打 tag。**

- **v0.4.0（2026-09-20，tag `v0.4.0` → `36e27e4`）**：解锁 WorkBuddy 5.6.0 的 at-rest 加密凭据，并让失败原因可诊断。**本条之前列在「未发布改动」里的两项也含在本版**：① 默认档位 = 声明集次高档（`WorkBuddyPiAiAdapter.resolveModel` 重写 `reasoning.defaultEffort`）；② 默认档位 400（code 11150）修复（`off` 只在 `supportedEfforts` 真的声明它时才映射，`canDisableThinking` 不再参与档位暴露）。两项的完整推理见下文「发布历史」。

- **v0.2.6（2026-09-02）**：PR #9（winliyou）回移费率显示与思考强度 + 跟进调整。**思考强度改为「仅声明集」（#9 跟进）**：#9 对无 `supportedEfforts` 声明的旧形模型（`{effort, summary}` 形态，11 个）回退到完整 pi-ai 梯度，含 `minimal`——但 `minimal` 既不在其实测清单（low/medium/high/xhigh/max，且只实测了 auto 一个模型）也不在上游 effort 词汇表；App 端对旧形模型本身区别对待（GLM-5.2 有思考控件、MiniMax-M3 / Kimi-K2.6 没有），可选集是客户端私有知识；workbuddy2api 亦按声明门控、出集降级而非透传。故调整为「仅声明集」：有 `supportedEfforts` 的 4 个模型（hy4-preview / hy3-x / glm-5.3 / glm-5.3-flash）按声明暴露档位，其余模型不暴露思考控件、请求不带 `reasoning_effort`，上游用自己的默认档（与 #9 之前行为一致）。后续若抓包确认客户端对旧形模型实际发送的值，再按证据逐模型放开。

- **回移 alpha 分支的费率显示与思考强度（PR #9）**：把 alpha 分支（5a5fac6）里除「适配 dsh 0.1.2-alpha.3」之外的功能搬回稳定线——依赖仍锁 `dsh 0.1.1-rc.2` / pi-ai `0.82.1`，客户端仍走 `@deepseek-ai/dsh-client-runtime` 的 `ClientContext`，设置段仍用 `settingsNamespace()` / `installSettingsSection()`。搬过来的四块：① 费率显示（`normalizeCredits` + `WorkBuddyPiAiAdapter` 覆写 `listModels`/`resolveModel`）；② 上游 `reasoning` / `credits` / `tags` 解析与逐模型思考强度；③ `developer` → `system` 角色改写（HTTP 400 11128）；④ 兜底目录同步到 15 个 cli 模型。已确认旧依赖同样支持：`dsh-llm-pi-ai` 0.1.1-rc.2 的 `PiAiAdapter.listModels/resolveModel` 可被覆写，pi-ai 0.82.1 有 `ModelThinkingLevel` / `ThinkingLevelMap` 且 `openai-completions.js` 转发 `reasoning_effort`（第 634 行）、发 `developer` role（第 788 行）。

- **费率显示（实现要点，随 v0.3.0-alpha.0 引入，本次回移）**：模型选择列表里每个模型名直接带积分倍率（`GLM-5.2 · x0.79`），`/model` 弹窗与 composer 下拉都可见；设置卡片「模型优惠」补上倍率行。① `normalizeCredits`（`src/upstream.ts`）把上游 `x0.79 credits` 归一成语言无关的 `x0.79`——host 侧 LLM seam 无 locale 服务，任何文案都会原样进浏览器，所以必须去掉 `credits` 单位词；② `src/adapter.ts` 子类化 `PiAiAdapter`（`WorkBuddyPiAiAdapter`）覆写 `listModels` / `resolveModel`，把费率拼进 `name`（分隔符用 ` · `，模型名本身含连字符）并同时放进 `description`——因为 DSH 的 `/model` 弹窗渲染 `description` 而 composer 的 ModelSelect 只渲染 `name`，两者都要覆盖；③ 费率只改显示字段：pi-ai 请求体用 `model.id`（`openai-completions.js` 两处 `model: model.id`），选择回传也是 id，`dsh-llm` 对 name 只校验非空字符串，已确认无按 name 的查找/比对逻辑；④ 卡片侧走浏览器 locale（`rate` 键：`{rate} 积分/次` / `{rate} credits per message`），host 只传归一化后的 `credits` 字段。

- **思考强度按模型分别处理（2026-09-01，本次回移）**：WorkBuddy 上游 `reasoning` 对象有两种形态——新形态带显式 `supportedEfforts` + `canDisableThinking`（hy4-preview/hy3-x/glm-5.3/glm-5.3-flash），旧形态只有 `{effort, summary}`（auto/hy3/glm-5.2 等绝大多数）。修正确认：① 旧形态模型上游**接受完整档位集**（实测 low/medium/high/xhigh/max 全 200），并非只支持默认档，所以 DSH 里应显示完整档位（`minimal/low/medium/high/xhigh/max`），而不是只剩 Off；② `off` 仅当显式 `canDisableThinking:true` 才提供（旧形态大多拒绝 off，实测 auto off=400）；③ 参考 workbuddy2api 的 `normalizeReasoningEffort`（按模型 supportedEfforts 降级、无 supportedEfforts 透传），与上游行为对齐。参考见 `workbuddy2api/internal/upstream/payload.go`。

- **11128 developer-role 拦截修复（2026-09-01，本次回移）**：DSH 发消息报 `HTTP 400 code:11128 "Illegal API invocation from an unapproved channel"`。根因：pi-ai 把系统提示作为 `role:"developer"` 发送（OpenAI 新惯例），但 WorkBuddy 上游**拒绝 developer role**（HTTP 400 11128）；直连测试用 `role:"system"`/`"user"` 所以复现不出。修复：`prepareChatBody` 在转发前把所有 `role:"developer"` 消息改写为 `role:"system"`。用 agent-browser 操作真实 DSH 界面复现并验证修复后 Deepseek-V4-Flash+Max 正常回复。附带确认 `hy4-preview` 是限时免费模型，上游稳定返回 `HTTP 429:6000`（限流）。

- **v0.2.5（2026-08-29）**：图片输入支持——解析上游 `supportsImages` / `disabledMultimodal`，逐模型声明 `input` 模态（16 个 cli 模型中 15 个可发图，`glm-5.1` 除外），离线兜底目录同步补齐真值。定位与决策记录见 `docs/image-modality-gap.md`。
- **v0.2.4（2026-08-28）**：合并 PR #4（CallMeSoul）：WSL 下自动发现 Windows 桌面端凭据（挂载的 Windows 用户目录按 Local → Roaming → 原生 Linux 顺序探测，支持转发的 Windows 环境变量）。
- **v0.2.3（2026-08-26）**：修复版本显示瑕疵（产物烙旧版本号）+ README 补充 web / desktop / TUI 三端安装说明。
- **v0.2.2（2026-08-24）**：修复 Windows 凭据路径探测（Local → Roaming，issue #1）。

## 发布历史（v0.3.x / v0.4.x 的详细推理）

这两条在「最近发布」里被折叠，完整推理保留如下，因为它们是后续改动的地基：

- **v0.3.0（2026-08-28，tag `v0.3.0` → `817975d`）**：模型目录改为**纯本地**——新增 `src/v3-config.ts` 解析 `~/.workbuddy/cache/acc-product-config-v3.json`，按 `cli` agent 的 id 列表取完整字段；`fetchModels` 去掉远程请求与 credential 参数。`contextWindow` 取值顺序固定为 `maxInputTokens → maxAllowedSize → defaultLength`（避免 `defaultLength` 作为厂商族默认值虚高，例如 `claude-opus-4.8` 报 1M 实为 200K）。实测 31 个模型、约 5ms，含此前缺失的 `hy4-preview-ioa` 与 `echo`。**注：本次只删了远程请求，网络解析分支的其余残留在 v0.4.0 的 `7d10f7b` 才清干净。**

- **默认档位 = 声明集的次高档（随 v0.4.0 发布）**：`WorkBuddyPiAiAdapter.resolveModel` 把 `reasoning.defaultEffort` 重写成该模型 `supportedEfforts` 的**次高档**（只有一个档位时就是该档）。DSH 的语义是「`defaultEffort` 会被 materialize 进未指定档位的请求，且 picker 只在它缺席时才提供 "provider default" 项」（`dsh-llm` 的 `LlmModelReasoningInfo` 类型注释 + `dsh-client-ui-model-selection` 的 `choices` / `effortChoices`），所以上报它同时达成两件事：默认请求带上一个上游必然接受的声明值，picker 里不再出现「默认」选项。上游自己的 `defaultEffort`（观测到的都是 `high`）不采用——它不等于次高（如 `gpt-6-astra` 五档的次高是 `xhigh`），且上游的接受集只由 `supportedEfforts` 定义。只在 `resolveModel` 生效：`LlmModelInfo`（list 形态）没有 reasoning 字段，picker 的分组目录由 resolved 答案构建。边界：两档模型（如 `hy3-ioa` / `deepseek-v4-pro-ioa`）的次高即较低那档。

- **默认档位 400（code 11150）修复（随 v0.4.0 发布）**：`toPiModel` 曾把 `canDisableThinking: true` 的模型的 `thinkingLevelMap.off` 映射成字符串 `'off'`。pi-ai 对 `off` 的语义是「未选档位时发送 `thinkingLevelMap.off`」（`openai-completions.js` 的 `typeof offValue === "string"` 分支），于是每次不带显式档位的请求都会发 `reasoning_effort: "off"` —— 上游按模型的 `supportedEfforts` 严格校验（`deepseek-v4.1-flash` 只声明 `['low','high','max']`），返回 HTTP 400 code 11150。`hy4-preview-ioa` 不出问题是因为它 `canDisableThinking: false` → `map.off = null` → 不发字段。修复：`off` 只在上游 `supportedEfforts` 真的声明它时才映射（`WorkBuddyEffort` 词表同步收编 `'off'`）；`canDisableThinking` 降级为纯上游事实镜像，不再参与档位暴露。桌面端 CLI 的关闭语义是「删除 `reasoning_effort`」而非发 `off`，与此一致。

## 文档索引

- [`docs/model-catalog-refresh.md`](docs/model-catalog-refresh.md) —— 模型列表的解析链路、缓存所有权、手动刷新机制、三种刷新手段的取舍、排查清单。
- [`docs/dsh-0.1.6-compat.md`](docs/dsh-0.1.6-compat.md) —— 类型锁 0.1.2-alpha.5 但运行在 0.1.6-alpha.2 上的已知偏差、破坏性变更、升依赖检查清单。
- [`docs/image-modality-gap.md`](docs/image-modality-gap.md) —— 图片输入被拦截的定位与修复（v0.2.5）。

## 发布规矩

未经明确指令不得 `npm publish` / 打 release tag；发布前 `pnpm run check` 全过，顺序固定：**先升版本号，再 check/构建，最后发布**。
