# dsh-workbuddy-connect Agent Notes

## 待办

- PR #4（WSL 凭据发现）已合并进 v0.2.4：等作者 CallMeSoul 基于 npm 包回归验证（PR 评论里已请求）。

## 本 fork（-oo）与上游的差异

本仓库是 `dsh-workbuddy-connect-oo`，相对上游 corrinehu/dsh-workbuddy-connect 的独立演进，合上游更新时需注意以下偏离：

- **插件身份**：包名 `dsh-workbuddy-connect-oo`，provider 路由 `workbuddy-oo`，bin 名同步改名；与上游插件可并存不冲突。
- **模型目录来源**：`fetchModels()` 改为读本地 `/v3/config` 缓存（`~/.workbuddy/cache/acc-product-config-v3.json`，可用 `ACC_PRODUCT_CONFIG_PATH` 覆盖），不再请求 `/console/enterprises/personal/models`。原因是企业端点目录更窄，缺 `hy4-preview-ioa`、`echo` 等 cli-only 模型；且本地读无需凭据、不发网络请求，不会与桌面端的列表漂移。
  - **合上游时的坑**：上游对模型字段的改动（如 v0.2.5 的 `supportsImages`）落在网络解析分支里，直接合并会静默失效——必须同步补进 `src/v3-config.ts` 的 `toModel()`。
- **推理强度透传**：`src/adapter.ts` 按三优先级解析档位（后端 `supportedEfforts` → 内置 `BUILTIN_THINKING_LEVEL_MAP` → 固定 `effort` 单档），并带 `deepseek -ioa` 档位补全。
- **上游请求身份**：UA 用 `WorkBuddy/5.3.14` 并附 `X-IDE-*` 头；按 `enterpriseId` 走企业模型端点。

## 最近发布

- **v0.2.5（2026-08-29）**：图片输入支持——解析上游 `supportsImages` / `disabledMultimodal`，逐模型声明 `input` 模态（16 个 cli 模型中 15 个可发图，`glm-5.1` 除外），离线兜底目录同步补齐真值。定位与决策记录见 `docs/image-modality-gap.md`。
- **v0.2.4（2026-08-28）**：合并 PR #4（CallMeSoul）：WSL 下自动发现 Windows 桌面端凭据（挂载的 Windows 用户目录按 Local → Roaming → 原生 Linux 顺序探测，支持转发的 Windows 环境变量）。
- **v0.2.3（2026-08-26）**：修复版本显示瑕疵（产物烙旧版本号）+ README 补充 web / desktop / TUI 三端安装说明。
- **v0.2.2（2026-08-24）**：修复 Windows 凭据路径探测（Local → Roaming，issue #1）。

## 发布规矩（同工作区根 AGENTS.md）

未经明确指令不得 `npm publish` / 打 release tag；发布前 `pnpm run check` 全过，顺序固定：**先升版本号，再 check/构建，最后发布**。
