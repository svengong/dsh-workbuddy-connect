window.__ModuleLoader__.load({
	id: "dsh-workbuddy-connect-oo",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/status-paths.ts
		/**
		* Plugin-owned model-refresh endpoint consumed by its browser half.
		*
		* A separate path from the status document because this one changes registry
		* state: it re-reads the local product-config cache and republishes the
		* provider's routes, which is what makes DSH re-read the model catalog. It is
		* therefore POST-only and gated on a loopback Host as well as a loopback
		* Origin, so a cross-origin page cannot drive it.
		*/
		const WORKBUDDY_REFRESH_PATH = "/plugins/dsh-workbuddy-connect/refresh-models";
		//#endregion
		//#region src/client/RefreshModelsButton.tsx
		/**
		* Model-page footer button: re-read the WorkBuddy model cache on demand.
		*
		* The picker's catalog is cached per Host generation by the client, and the
		* Host answers `session.modelCatalog()` from the live LLM registry, so a list
		* that changed on disk (the desktop app rewrote its product-config cache)
		* stays invisible until something re-reads it. This button drives the Host
		* route that does both halves — re-read the cache, then republish the
		* provider's routes — and DSH's own `llm/adapters-updated` handler takes care
		* of the rest. No reload, no DSH restart.
		*
		* It lives in the Models settings page's footer slot because that is where a
		* user looking at the model list already is, and because it is the plugin's
		* only browser surface: the account/credit card this plugin used to ship
		* registered into `settings.plugin.item`, which DSH 0.1.6-alpha.2 removed.
		*
		* @module dsh-workbuddy-connect/client/RefreshModelsButton
		*/
		const wrapStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			flexWrap: "wrap",
			gap: 12,
			padding: "4px 0"
		};
		const textStyle = {
			display: "flex",
			minWidth: 0,
			flexDirection: "column",
			gap: 3,
			flex: "1 1 260px"
		};
		const titleStyle = {
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		const hintStyle = {
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const buttonStyle = {
			boxSizing: "border-box",
			minHeight: 34,
			padding: "6px 14px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 18,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 14,
			cursor: "pointer"
		};
		const busyButtonStyle = {
			...buttonStyle,
			cursor: "default",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const outcomeStyle = {
			flexBasis: "100%",
			margin: 0,
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-state-success-primary, #22a06b)"
		};
		const errorOutcomeStyle = {
			...outcomeStyle,
			color: "var(--dsw-alias-state-error-primary, #d92d20)"
		};
		/** Render the outcome line, or nothing before the first refresh. */
		function outcomeText(outcome, t) {
			if (outcome.kind === "ok") return outcome.models === 0 ? t("refreshModelsOkEmpty") : t("refreshModelsOk", { count: outcome.models });
			if (outcome.kind === "error") return t("refreshModelsFailed", { message: outcome.message });
		}
		/**
		* One button that re-reads the WorkBuddy model cache and republishes it.
		* @param props - the registration's injected translate seat.
		* @returns the footer row, or nothing when copy is missing.
		*/
		function RefreshModelsButton({ t }) {
			const [busy, setBusy] = (0, react.useState)(false);
			const [outcome, setOutcome] = (0, react.useState)({ kind: "idle" });
			const mounted = (0, react.useRef)(true);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			const refresh = (0, react.useCallback)(async () => {
				if (t === void 0) return;
				setBusy(true);
				try {
					const response = await fetch(WORKBUDDY_REFRESH_PATH, {
						method: "POST",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					if (response.status === 403) {
						if (mounted.current) setOutcome({
							kind: "error",
							message: t("refreshModelsForbidden")
						});
						return;
					}
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const value = await response.json();
					if (!mounted.current) return;
					setOutcome(value.status === "ok" ? {
						kind: "ok",
						models: value.models
					} : {
						kind: "error",
						message: value.message
					});
				} catch (error) {
					if (!mounted.current) return;
					setOutcome({
						kind: "error",
						message: error instanceof Error ? error.message : String(error)
					});
				} finally {
					if (mounted.current) setBusy(false);
				}
			}, [t]);
			if (t === void 0) return null;
			const detail = outcomeText(outcome, t);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: wrapStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: textStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: titleStyle,
							children: t("refreshModels")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: hintStyle,
							children: t("refreshModelsHint")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: busy ? busyButtonStyle : buttonStyle,
						disabled: busy,
						"aria-label": t("refreshModels"),
						onClick: () => {
							refresh();
						},
						children: busy ? t("refreshModelsBusy") : t("refreshModels")
					}),
					detail === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: outcome.kind === "error" ? errorOutcomeStyle : outcomeStyle,
						role: "status",
						children: detail
					})
				]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Copy for the plugin's browser surface, registered under the
		* `settings.workbuddy` locale namespace.
		*
		* Only the manual model refresh lives here. The account/credit card this
		* namespace used to carry was retired with DSH 0.1.6-alpha.2, which removed the
		* `settings.plugin.item` slot it registered into; its copy went with it, and
		* `git log -- src/client/WorkBuddyPluginCard.tsx` has the rest.
		*/
		const en = {
			refreshModels: "Refresh model list",
			refreshModelsBusy: "Refreshing…",
			refreshModelsHint: "Re-reads the WorkBuddy desktop app's local model cache and republishes the provider, so the picker updates without restarting DSH.",
			refreshModelsOk: "Refreshed: {count} models",
			refreshModelsOkEmpty: "Refreshed, but the cache lists no models",
			refreshModelsFailed: "Refresh failed: {message}",
			refreshModelsForbidden: "Refresh refused: it must come from a loopback address (127.0.0.1 / localhost)."
		};
		const zh = {
			refreshModels: "刷新模型列表",
			refreshModelsBusy: "正在刷新…",
			refreshModelsHint: "重新读取 WorkBuddy 桌面 App 的本地模型缓存并重新发布模型，选择器立即更新，无需重启 DSH。",
			refreshModelsOk: "已刷新：{count} 个模型",
			refreshModelsOkEmpty: "已刷新，但缓存里没有模型",
			refreshModelsFailed: "刷新失败：{message}",
			refreshModelsForbidden: "刷新被拒绝：该请求必须来自本机回环地址（127.0.0.1 / localhost）。"
		};
		//#endregion
		//#region src/client/index.tsx
		/**
		* The Models settings page's footer slot: `kind: 'list'`, `scope: 'root'`,
		* declared by DSH's own `ui-settings-models` ("without a registrant the area
		* renders nothing").
		*/
		const MODELS_FOOTER_SLOT = "settings.models.footer";
		/** Stable browser-plugin name. */
		const name = "dsh-workbuddy-connect-client";
		/** Client services required by the Plugin configuration contribution. */
		const inject = ["slots", "locale"];
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
		function apply(ctx) {
			try {
				const namespace = "settings.workbuddy";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddy-connect: settings copy");
				const t = ctx.locale.bind(namespace);
				const lateSlots = ctx.slots;
				lateSlots.inject(MODELS_FOOTER_SLOT, () => lateSlots.register({
					name: MODELS_FOOTER_SLOT,
					id: "workbuddy-oo-refresh-models",
					order: 30,
					inject: () => ({ t })
				}, RefreshModelsButton));
			} catch (error) {
				console.error("[dsh-workbuddy-connect] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
