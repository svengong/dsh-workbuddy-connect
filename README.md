# DSH WorkBuddy Connect


[English](./README.en.md) | 中文


将 WorkBuddy 桌面 App 中包含的各种模型（GLM-5.3、GLM-5.2、DeepSeek-V4-Pro、DeepSeek-V4-Flash、Kimi-K3、MiniMax-M3 、Hy3等）自动接入 DeepSeek Harness，实现在 DSH 对话窗口里零配置使用。


## 功能

- **开箱即用**：安装和启用插件后，在 DSH 中直接使用，无需额外配置。


![WorkBuddy 模型出现在 DSH 模型选择器中](assets/1.png)


- **图片输入**：按上游逐模型声明的能力放行图片——绝大多数模型（含 GLM-5.3-Flash、GLM-5.2、DeepSeek-V4 系列等）可直接粘贴或拖入图片；个别纯文本模型（如 GLM-5.1）按上游声明仍会明确提示不支持。


- **思考强度**：按上游每个模型声明的 `supportedEfforts` 提供思考等级选项（如 GLM-5.3 支持 low / high / xhigh，GLM-5.3-Flash 支持 low / high / max），在 DSH 模型选择器里即可切换，请求以 `reasoning_effort` 转发。


- **限时免费一目了然**：模型名上直接标出当前免费 / 限时免费 / 夜间折扣（跟随上游 `credits` 与 `tags` 实时更新）。


- **费率比例直接可见**：模型选择列表里每个模型名后直接显示积分倍率（如 `GLM-5.2 · x0.79`、`Hy3 · x0.00`），`/model` 弹窗与 composer 下拉都能看到。倍率只影响显示，发送请求仍使用模型 id。


- **手动刷新模型列表**：设置 → 模型 → WorkBuddy 卡片里有一个「刷新模型列表」按钮。模型列表来自 WorkBuddy 桌面 App 的本地缓存，App 更新缓存后点一下即可让 DSH 立刻重新读取并发布，**不需要重启 DSH**。详见 [`docs/model-catalog-refresh.md`](./docs/model-catalog-refresh.md)。


## 安装

前置：已安装并登录 WorkBuddy 桌面 App（插件复用 App 的登录状态，账号切换自动跟随）。

插件在三种 DSH 界面下均可运行：**Web**、**Desktop**、**TUI**。根据你使用的 profile 选对应命令安装。

> 本仓库**只维护本地 git，不发布到 npm**（`package.json` 已标 `"private": true`），所以用**本地路径**安装。pnpm 会把仓库文件**硬链接**进 profile 的 `node_modules`：`package.json` 这类不被重写的文件一下就会同步过去（**版本号会立刻变**），而 `lib/` 是每次构建重写出来的，链接会断开、**必须重装**。

```sh
# 首次安装（Web，推荐）
cd /path/to/dsh-workbuddy-connect && pnpm run build
dsh plugin --profile web add file:/path/to/dsh-workbuddy-connect
dsh web

# 改了代码后重新装进 profile —— 用仓库里的脚本，不要手敲 add
node scripts/reinstall-local.mjs          # 默认 web，可传 desktop / dsh-tui
```

> 为什么需要脚本：pnpm 对本地目录依赖**不记录任何内容哈希**（lockfile 里是 `resolution: {directory: …, type: directory}`，没有 integrity），所以 `add`、`add --force`、`update`、`install --force` 全是空操作，只有 `remove` + `add` 会重写副本。脚本封装了这一步，并顺带恢复被 `remove`/`add` 打乱的 `dsh.profile.bundles` 顺序、逐字节校验副本、告诉你该刷新页面还是重载插件。

```sh
# Desktop（DSH Desktop 桌面版）
dsh plugin --profile desktop add file:/path/to/dsh-workbuddy-connect
dsh --profile desktop
```

```sh
# TUI（终端界面）
dsh plugin --profile dsh-tui add file:/path/to/dsh-workbuddy-connect
dsh --profile dsh-tui
```

> 提示：`dsh-tui` profile 需用 pnpm 11 安装（PATH 里是其他版本会报 `ERR_PNPM_UNEXPECTED_STORE`，用 `npx pnpm@11` 即可）。
>
> 改了代码后可用的三种刷新方式（页面刷新 / 重载插件 / 重启 DSH）与各自生效范围见 [`docs/model-catalog-refresh.md`](./docs/model-catalog-refresh.md) 第 4 节。

安装后，在对应界面的模型选择器里切换到 WorkBuddy 模型即可使用；**设置 → 模型** 页的 WorkBuddy 卡片里有「刷新模型列表」按钮，TUI 下可在 `/settings` 里配置 `authFile`。

## 命令行

`dsh-workbuddy-connect-oo status`：登录状态与剩余积分（`--json` 输出机器可读格式；另有 `doctor` 诊断、`logout` 清理凭据）。

`doctor --json` 还会报出模型缓存文件的位置与条数，是排查"模型列表不更新"的第一步：

```sh
dsh-workbuddy-connect-oo doctor --json
```

它同时报两个**构建号**：`build` 是你正在执行的这份副本，`hostHeartbeat.pluginBuild` 是 **DSH 里正在运行的 host**。两者不一致（或显示 `unknown`）就说明 host 还是旧构建，需要刷新页面或重启 DSH —— 光看版本号分辨不出来，因为同一版本可以对应多次构建。

## 已知限制

- 在 macOS 的 DSH Web / Desktop / TUI profile（Node 22+）下验证通过；Web 端已在 DSH `0.1.6-alpha.2` 上实测。Windows 会依次探测 Local 与 Roaming AppData；WSL 会优先从挂载的 Windows 用户目录读取登录凭据。若 Windows 与 Linux 用户名不同且 Windows 环境变量未传入 WSL，请通过 `WORKBUDDY_AUTH_FILE` 指定实际位置。
- 模型列表只读 WorkBuddy 桌面 App 的本地缓存，插件不联网取目录。因此**新增模型的前提是桌面 App 自己刷新过缓存**；插件侧用「刷新模型列表」按钮让 DSH 重读。缓存不可读时该 provider 显示为空列表，而不是回退到可能过期的内置目录。
- 依赖 WorkBuddy 客户端接口（非官方开放 API），WorkBuddy 更新后插件可能需要随之调整。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 WorkBuddy 的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
- 本项目与腾讯、WorkBuddy、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 致谢

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）— WorkBuddy 上游协议的参照实现。
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect)（Apache-2.0）— DSH 插件结构与 provider 注册的参照。

## 来源与许可

本仓库 `dsh-workbuddy-connect-oo` 派生自 **corrinehu/dsh-workbuddy-connect**（MIT，Copyright (c) 2026 Corrine Hu），在其基础上独立演进。

- **保持上游身份不改的部分**：`LICENSE` 里的原始版权声明按 MIT 要求原样保留。
- **本分支的偏离**：包名改为 `dsh-workbuddy-connect-oo`、provider 路由改为 `workbuddy-oo`，避免与上游插件同时安装时冲突；模型目录只读本地缓存（上游还有网络与静态兜底）。差异清单见 [`AGENTS.md`](./AGENTS.md)。
- **分发状态**：本仓库只维护本地 git，不推送、不发布到 npm（`package.json` 已标 `"private": true`）。安装方式是本地路径，不是远程仓库。

## 许可证

[MIT](./LICENSE)（上游原始版权声明保留于 [`LICENSE`](./LICENSE)）
