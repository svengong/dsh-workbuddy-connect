# DSH WorkBuddy Connect

English | [中文](./README.md)

Brings every model in the WorkBuddy desktop app (GLM-5.3, GLM-5.2, DeepSeek-V4-Pro, DeepSeek-V4-Flash, Kimi-K3, MiniMax-M3, Hy3, and more) straight into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — zero configuration in the DSH chat.

## Features

- **Works out of the box**: install and enable the plugin, then use it directly in DSH — no extra configuration.

![WorkBuddy models in the DSH model picker](assets/1.png)

- **Image input**: image messages are admitted per the upstream's per-model capability flag — most models (GLM-5.3-Flash, GLM-5.2, the DeepSeek-V4 series, etc.) accept pasted or dragged-in images, while text-only models (e.g. GLM-5.1) keep a clear refusal.

- **Thinking effort**: the model picker exposes the per-model effort levels the upstream declares (e.g. GLM-5.3 offers low / high / xhigh, GLM-5.3-Flash low / high / max), forwarded as `reasoning_effort` on the wire.

- **Limited-time free at a glance**: the model name carries the current free / limited-time free / night-discount state (following the upstream `credits` and `tags` live).

- **Rate ratio at a glance**: every model in the selection list carries its credits multiplier on the name (e.g. `GLM-5.2 · x0.79`, `Hy3 · x0.00`), in both the `/model` popup and the composer seat. The rate is display-only — requests always use the model id.

- **Manual model-list refresh**: Settings → Models → the WorkBuddy card carries a "Refresh model list" button. The list comes from the WorkBuddy desktop app's local cache, so after the app rewrites it, one click makes DSH re-read and republish the models — **no DSH restart**. See [`docs/model-catalog-refresh.md`](./docs/model-catalog-refresh.md).

## Install

Prerequisite: the WorkBuddy desktop app is installed and signed in (the plugin reuses the app's sign-in state and follows account switches automatically).

The plugin runs under all three DSH interfaces: **Web**, **Desktop**, and **TUI**. Pick the install command that matches the profile you use.

```sh
# First install (Web, recommended)
cd /path/to/dsh-workbuddy-connect && pnpm run build
dsh plugin --profile web add file:/path/to/dsh-workbuddy-connect
dsh web

# After changing code, reinstall into the profile — use the repo script, not a hand-run add
node scripts/reinstall-local.mjs          # defaults to web; pass desktop / dsh-tui to switch
```

> Why a script: pnpm records **no content hash** for a local directory dependency (the lockfile says
> `resolution: {directory: …, type: directory}`, with no integrity), so `add`, `add --force`, `update`
> and `install --force` are all no-ops — only `remove` + `add` rewrites the copy. The script wraps that
> step and also restores the `dsh.profile.bundles` order that remove/add shuffles, verifies the installed
> copy byte-for-byte, and tells you whether to refresh the page or reload the plugin.

```sh
# Desktop (the DSH Desktop app)
dsh plugin --profile desktop add file:/path/to/dsh-workbuddy-connect
dsh --profile desktop
```

```sh
# TUI (terminal UI)
dsh plugin --profile dsh-tui add file:/path/to/dsh-workbuddy-connect
dsh --profile dsh-tui
```

> Note: the `dsh-tui` profile requires pnpm 11 to install packages (a different pnpm on PATH fails with `ERR_PNPM_UNEXPECTED_STORE` — use `npx pnpm@11`).
>
> This repository is **maintained as local git only and is not published to npm** (`package.json` is marked `"private": true`), so it installs by **local path**. pnpm then places a **physical copy** (plain files, not a symlink) in the profile's `node_modules`. See section 4 of [`docs/model-catalog-refresh.md`](./docs/model-catalog-refresh.md) for the three ways to pick up changes (page refresh / plugin reload / DSH restart) and what each one covers.

After installing, switch to a WorkBuddy model in the model picker of the interface you chose. On Web, the WorkBuddy card under **Settings → Models** carries the "Refresh model list" button; on TUI, configure `authFile` in `/settings`.

## CLI

`dsh-workbuddy-connect-oo status`: sign-in state and remaining credit (`--json` for machine-readable output; `doctor` for diagnostics and `logout` for credential cleanup are also available).

`doctor --json` also reports where the model cache lives and how many models it holds — the first thing to check when the model list looks stale:

```sh
dsh-workbuddy-connect-oo doctor --json
```

## Known limitations

- Verified on macOS with the DSH Web / Desktop / TUI profile (Node 22+); the Web half is tested against DSH `0.1.6-alpha.2`. Windows probes Local and Roaming AppData in order; WSL first reads credentials from the mounted Windows user profile. If the Windows and Linux user names differ and Windows environment variables are not forwarded into WSL, point `WORKBUDDY_AUTH_FILE` at the actual file.
- The model list is read only from the WorkBuddy desktop app's local cache; the plugin never fetches a catalog over the network. New models therefore require the desktop app to refresh that cache first, after which the "Refresh model list" button makes DSH re-read it. An unreadable cache serves an empty list for that provider rather than falling back to a possibly stale built-in catalog.
- Relies on WorkBuddy client interfaces (not a public API); the plugin may need updates as WorkBuddy changes.

## Disclaimer

- This project is for **personal learning and research only**, driving your own WorkBuddy account on your own machine. Do not use it commercially or beyond reasonable personal use.
- Users must comply with the WorkBuddy terms of service. Any consequence of using this project (including but not limited to account restrictions, depleted credit, or service interruption) is borne by the user.
- The author is not liable for any direct or indirect loss arising from the use or misuse of this project.
- This project is not affiliated with, endorsed by, or sponsored by Tencent, WorkBuddy, or DeepSeek. Product names are used for compatibility description only; trademarks belong to their respective owners.

## Acknowledgements

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) (MIT) — reference implementation of the WorkBuddy upstream protocol.
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect) (Apache-2.0) — reference for the DSH plugin structure and provider registration.

## Provenance and licensing

This repository, `dsh-workbuddy-connect-oo`, is derived from **corrinehu/dsh-workbuddy-connect** (MIT, Copyright (c) 2026 Corrine Hu) and evolves independently from it.

- **Kept as upstream**: the original copyright notice in `LICENSE` is preserved verbatim, as the MIT license requires.
- **Divergences in this branch**: the package name is `dsh-workbuddy-connect-oo` and the provider route is `workbuddy-oo`, so it can coexist with the upstream plugin; the model catalog is read only from the local cache (upstream also has network and static fallbacks). The full divergence list is in [`AGENTS.md`](./AGENTS.md).
- **Distribution**: this repository is maintained as local git only — never pushed, never published to npm (`package.json` is marked `"private": true`). Installation is by local path, not from a remote repository.

## License

[MIT](./LICENSE) (the upstream copyright notice is preserved in [LICENSE](./LICENSE))
