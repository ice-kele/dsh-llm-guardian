window.__ModuleLoader__.load({
	id: "dsh-llm-guardian",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		const reactDom = require("react-dom");
		const reactClient = require("react-dom/client");
		const h = react.createElement;
		const NS = "llm-guardian";

		function number(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : undefined;
		}

		function fmt(value) {
			const n = number(value);
			if (n === undefined) return "—";
			if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2).replace(/\.00$/, "") + "B";
			if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
			if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
			return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(n);
		}

		function fmtTime(timestamp) {
			if (!timestamp) return "";
			try {
				return new Intl.DateTimeFormat("zh-CN", {
					month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
				}).format(new Date(timestamp));
			} catch {
				return "";
			}
		}

		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}

		async function guardianRequest(ops) {
			const response = await fetch("/plugins/dsh-llm-guardian/api", ops ? {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ops }),
			} : { cache: "no-store" });
			let payload;
			try {
				payload = await response.json();
			} catch {
				throw new Error("用量统计服务返回了无效响应");
			}
			if (!response.ok || !payload || payload.ok !== true) {
				throw new Error(payload && payload.error ? String(payload.error) : "用量统计服务请求失败");
			}
			return payload.value && typeof payload.value === "object" ? payload.value : {};
		}

		function defaultScript(provider) {
			if (provider === "zai-coding-cn") {
				return `({
  request: {
    url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    method: "GET",
    headers: {
      Authorization: "{{apiKey}}",
      "Content-Type": "application/json",
      "Accept-Language": "zh-CN,zh;q=0.9"
    }
  },
  extractor(response) {
    const data = response && response.data && typeof response.data === "object" ? response.data : {};
    const source = Array.isArray(data.limits) ? data.limits : [];
    const tiers = source
      .filter(function (item) {
        const type = String(item && item.type || "").toUpperCase();
        return type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT";
      })
      .map(function (item, index) {
        const raw = Number(item.percentage);
        const used = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
        const unit = Number(item.unit);
        return {
          name: unit === 3 ? "5 小时窗口" : unit === 6 ? "每周窗口" : "额度 " + (index + 1),
          used: used,
          remaining: 100 - used,
          total: 100,
          nextResetTime: Number(item.nextResetTime) || 0
        };
      });
    const primary = tiers.find(function (tier) { return tier.name === "5 小时窗口"; }) || tiers[0];
    const valid = response && response.success !== false && Boolean(primary);
    return {
      isValid: valid,
      invalidMessage: valid ? "" : String(response && (response.msg || response.message) || "未返回 Coding Plan 额度"),
      planName: data.level ? "智谱 " + String(data.level) : "智谱 Coding Plan",
      ...(primary ? {
        remaining: primary.remaining,
        used: primary.used,
        total: primary.total,
        unit: "%"
      } : {}),
      extra: { tiers: tiers }
    };
  }
})`;
			}
			if (provider === "deepseek-official") {
				return `({
  request: {
    url: "{{baseUrl}}/user/balance",
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: "Bearer {{apiKey}}"
    }
  },
  extractor(response) {
    const balance = Array.isArray(response.balance_infos)
      ? response.balance_infos[0]
      : undefined;
    return {
      isValid: response.is_available !== false,
      invalidMessage: response.is_available === false ? "账户余额不可用" : "",
      remaining: balance ? Number(balance.total_balance) : undefined,
      unit: balance && balance.currency ? balance.currency : "CNY",
      planName: "DeepSeek 账户余额"
    };
  }
})`;
			}
			return `({
  request: {
    url: "{{baseUrl}}/usage",
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: "Bearer {{apiKey}}"
    }
  },
  extractor(response) {
    return {
      remaining: response.remaining,
      used: response.used,
      total: response.total,
      unit: response.unit || "",
      planName: response.planName || ""
    };
  }
})`;
		}

		function guardianValue(snapshot) {
			return snapshot && snapshot.value && typeof snapshot.value === "object" ? snapshot.value : {};
		}

		function providerState(snapshot, provider) {
			const value = guardianValue(snapshot);
			return {
				guardianEnabled: value.enabled !== false,
				quota: value.providers && value.providers[provider] ? value.providers[provider] : {},
				health: value.status && value.status[provider] ? value.status[provider] : undefined,
				script: value.usageScripts && value.usageScripts[provider] ? value.usageScripts[provider] : undefined,
				result: value.usageResults && value.usageResults[provider] ? value.usageResults[provider] : undefined,
			};
		}

		function createGuardianSource() {
			let snapshot = { loading: true, error: "", value: {} };
			let pending;
			let generation = 0;
			const listeners = new Set();
			const publish = (next) => {
				snapshot = next;
				for (const listener of listeners) listener();
			};
			const load = (force) => {
				if (pending && !force) return pending;
				const currentGeneration = ++generation;
				const request = guardianRequest().then((value) => {
					if (currentGeneration !== generation) return;
					publish({
						loading: false,
						error: "",
						value,
					});
				}).catch((error) => {
					if (currentGeneration !== generation) return;
					publish({ loading: false, error: messageOf(error), value: snapshot.value });
				}).finally(() => {
					if (pending === request) pending = undefined;
				});
				pending = request;
				return request;
			};
			const mutate = async (ops) => {
				await guardianRequest(ops);
				await load(true);
			};
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				load,
				mutate,
			};
		}

		function useGuardian(props) {
			const snapshot = props.useGuardian((value) => value);
			react.useEffect(() => { void props.load(false); }, [props.load]);
			return snapshot;
		}

		const C = {
			iconButton: {
				width: "28px", height: "28px", padding: 0, border: "none", borderRadius: "8px",
				background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer",
				display: "inline-flex", alignItems: "center", justifyContent: "center",
			},
			summary: {
				display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px", minHeight: "20px",
				padding: "4px 0 0", fontSize: "12px", color: "var(--dsw-alias-label-tertiary)",
			},
			dot: { width: "7px", height: "7px", borderRadius: "50%", display: "inline-block", flex: "none" },
			separator: { color: "var(--dsw-alias-border-l3)" },
			refresh: {
				width: "22px", height: "22px", padding: 0, border: "none", borderRadius: "6px", background: "transparent",
				color: "var(--dsw-alias-label-tertiary)", cursor: "pointer", display: "inline-flex", alignItems: "center",
				justifyContent: "center",
			},
			overlay: {
				position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,.46)", padding: "24px",
				display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box",
			},
			panel: {
				width: "min(820px, 100%)", maxHeight: "min(860px, calc(100vh - 48px))", overflow: "auto",
				boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px",
				background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)", padding: "18px",
				boxShadow: "0 20px 60px rgba(0,0,0,.3)", display: "flex", flexDirection: "column", gap: "14px",
			},
			titleRow: { display: "flex", alignItems: "flex-start", gap: "12px" },
			title: { margin: 0, fontSize: "17px", lineHeight: "24px", fontWeight: 600 },
			subtitle: { margin: "2px 0 0", fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" },
			close: {
				marginLeft: "auto", width: "28px", height: "28px", padding: 0, border: "none", borderRadius: "8px",
				background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", fontSize: "20px",
			},
			card: {
				border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "12px", padding: "12px",
				display: "flex", flexDirection: "column", gap: "10px", background: "var(--dsw-alias-bg-module-platform)",
			},
			cardHead: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			cardTitle: { margin: 0, fontSize: "14px", fontWeight: 600 },
			meta: { margin: 0, fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
			error: { margin: 0, fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-error-primary)", wordBreak: "break-word" },
			success: { margin: 0, fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-success-primary)" },
			warning: { margin: 0, fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-warn-label)" },
			fieldRow: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px" },
			label: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
			input: {
				height: "32px", boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px",
				padding: "0 10px", minWidth: "120px", background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: "13px",
			},
			button: {
				height: "30px", boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px",
				padding: "0 12px", background: "transparent", color: "var(--dsw-alias-label-primary)", cursor: "pointer",
				font: "inherit", fontSize: "12px", display: "inline-flex", alignItems: "center", justifyContent: "center",
			},
			primary: { border: "none", background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)" },
			danger: { color: "var(--dsw-alias-state-error-primary)" },
			disabled: { opacity: .45, cursor: "default" },
			bar: { height: "6px", borderRadius: "3px", overflow: "hidden", background: "var(--dsw-alias-border-l2)" },
			footer: { display: "flex", justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap", gap: "8px" },
			tabs: { display: "flex", alignItems: "center", gap: "4px", borderBottom: "1px solid var(--dsw-alias-border-l2)" },
			tabButton: {
				height: "34px", padding: "0 14px", marginBottom: "-1px", border: "none", borderBottom: "2px solid transparent",
				background: "transparent", color: "var(--dsw-alias-label-tertiary)", cursor: "pointer", font: "inherit", fontSize: "13px",
			},
			tabActive: { borderBottomColor: "var(--dsw-alias-label-primary)", color: "var(--dsw-alias-label-primary)", fontWeight: 600 },
			tabBody: { display: "flex", flexDirection: "column", gap: "14px", minWidth: 0 },
			queryToolbar: {
				display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap",
				padding: "12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "12px",
				background: "var(--dsw-alias-bg-module-platform)",
			},
			usageTierGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "8px" },
			usageTier: {
				minWidth: 0, padding: "10px 11px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
				background: "var(--dsw-alias-bg-module-platform)", display: "flex", flexDirection: "column", gap: "7px",
			},
			usageTierHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", fontSize: "12px" },
				settingGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" },
			settingItem: {
				display: "flex", flexDirection: "column", gap: "7px", minWidth: 0, padding: "11px",
				border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", background: "var(--dsw-alias-bg-layer-1)",
			},
			switchRow: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "14px" },
			switchCopy: { display: "flex", flexDirection: "column", gap: "2px" },
				compactStatsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "8px" },
			compactStat: {
				minWidth: 0, padding: "12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
				background: "var(--dsw-alias-bg-module-platform)", display: "flex", flexDirection: "column", gap: "6px",
			},
			compactStatValue: { fontSize: "20px", lineHeight: "26px", fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			select: {
				height: "32px", boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px",
				padding: "0 30px 0 10px", maxWidth: "240px", background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: "12px",
			},
		};

		function BarChartIcon() {
			return h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				h("path", { d: "M3 3v18h18" }),
				h("path", { d: "M7 16v-4" }),
				h("path", { d: "M12 16V8" }),
				h("path", { d: "M17 16V5" }),
			);
		}

		function ActivityIcon() {
			return h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				h("path", { d: "M3 12h4l2-7 4 14 2-7h6" }),
			);
		}

		function RefreshIcon() {
			return h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				h("path", { d: "M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5" }),
				h("path", { d: "M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" }),
			);
		}

		function statusDot(health) {
			if (!health) return "var(--dsw-alias-border-l3)";
			return health.ok ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)";
		}

		function resultText(result) {
			if (!result) return "尚未查询";
			if (!result.ok) return "查询失败";
			if (result.isValid === false) return result.invalidMessage || "套餐不可用";
			const unit = result.unit ? " " + result.unit : "";
			const prefix = result.planName ? result.planName + " · " : "";
			if (number(result.remaining) !== undefined) return prefix + "剩余 " + fmt(result.remaining) + unit;
			if (number(result.used) !== undefined && number(result.total) !== undefined) {
				return prefix + "用量 " + fmt(result.used) + " / " + fmt(result.total) + unit;
			}
			if (number(result.used) !== undefined) return prefix + "已用 " + fmt(result.used) + unit;
			if (number(result.total) !== undefined) return prefix + "总量 " + fmt(result.total) + unit;
			return result.planName || "查询成功";
		}

		function friendlyUsageError(error) {
			const message = String(error || "用量查询失败");
			if (message.includes("provider base URL is unavailable")) return "未找到 Provider 的 API 地址";
			if (message.includes("provider profile is unavailable")) return "Provider 配置不可用";
			if (message.includes("usage endpoint returned HTTP 401")) return "认证失败（HTTP 401），请检查 API 密钥";
			if (message.includes("usage endpoint returned HTTP 403")) return "无权查询套餐用量（HTTP 403）";
			if (message.includes("usage endpoint returned HTTP")) return message.replace("usage endpoint returned HTTP", "用量接口返回 HTTP");
			if (message.includes("usage endpoint did not return JSON")) return "用量接口没有返回有效数据";
			if (message.includes("usage request must use the provider endpoint origin")) return "用量接口与 Provider 地址不一致";
			return message;
		}

		function usageSucceeded(result) {
			return Boolean(result && result.ok && result.isValid !== false);
		}

		function usageFailure(result) {
			if (!result) return "用量查询失败";
			if (result.ok && result.isValid === false) return result.invalidMessage || "套餐不可用";
			return friendlyUsageError(result.error);
		}

		function usageTiers(result) {
			if (!result || !result.extraJson) return [];
			try {
				const extra = JSON.parse(result.extraJson);
				return extra && Array.isArray(extra.tiers) ? extra.tiers : [];
			} catch {
				return [];
			}
		}

		function tierShortName(name) {
			const text = String(name || "");
			if (text === "5 小时窗口" || text.toLowerCase() === "5h") return "5h";
			if (text === "每周窗口" || text.toLowerCase() === "7d") return "7d";
			return text;
		}

		function remainingTone(remaining) {
			const value = Number(remaining);
			if (!Number.isFinite(value)) return undefined;
			if (value <= 10) return "var(--dsw-alias-state-error-primary)";
			if (value <= 25) return "var(--dsw-alias-state-warn-label)";
			return "var(--dsw-alias-state-success-primary)";
		}

		function TooltipHost(props) {
			const hostRef = react.useRef(null);
			const [anchor, setAnchor] = react.useState(null);
			const show = () => {
				const node = hostRef.current;
				if (!node) return;
				const rect = node.getBoundingClientRect();
				setAnchor({ top: rect.bottom + 6, left: rect.left + rect.width / 2 });
			};
			const hide = () => setAnchor(null);
			return h(react.Fragment, null,
				h("span", {
					ref: hostRef, style: { display: "inline-flex", flex: "none" },
					onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide,
				}, props.children),
				anchor && props.label ? reactDom.createPortal(h("div", {
					role: "tooltip",
					style: {
						position: "fixed", top: anchor.top, left: anchor.left, transform: "translateX(-50%)",
						zIndex: 10001, padding: "4px 9px", borderRadius: "6px", fontSize: "12px", lineHeight: "18px",
						border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)",
						color: "var(--dsw-alias-label-primary)", boxShadow: "0 8px 24px rgba(0,0,0,.24)",
						pointerEvents: "none", whiteSpace: "nowrap",
					},
				}, props.label), document.body) : null,
			);
		}

		function BottomNotice(props) {
			const notice = props.notice;
			if (!notice) return null;
			return reactDom.createPortal(h("div", {
				role: "status", "aria-live": "polite", onClick: props.onClose,
				style: {
					position: "fixed", bottom: "28px", left: "50%", transform: "translateX(-50%)",
					zIndex: 10002, maxWidth: "min(420px, calc(100vw - 48px))",
					padding: "9px 14px", borderRadius: "10px", fontSize: "12px", lineHeight: "18px",
					border: "1px solid " + (notice.kind === "ok"
						? "var(--dsw-alias-state-success-primary)"
						: "var(--dsw-alias-state-error-primary)"),
					background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)",
					boxShadow: "0 12px 32px rgba(0,0,0,.28)", cursor: "pointer", whiteSpace: "normal", wordBreak: "break-word",
				},
			},
				h("strong", {
					style: {
						display: "block", marginBottom: "2px",
						color: notice.kind === "ok" ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)",
					},
				}, notice.title),
				notice.text,
			), document.body);
		}

		function TabsBar(props) {
			const barRef = react.useRef(null);
			const [indicator, setIndicator] = react.useState(null);
			const measure = react.useCallback(() => {
				const bar = barRef.current;
				if (!bar) return;
				const active = bar.querySelector('[data-active="true"]');
				if (!active) return;
				setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
			}, []);
			react.useEffect(() => { measure(); }, [props.value, measure]);
			return h("div", {
				ref: barRef, role: "tablist", "aria-label": props.label || "视图切换",
				style: { position: "relative", display: "flex", alignItems: "center", gap: "4px", borderBottom: "1px solid var(--dsw-alias-border-l2)" },
			},
				props.tabs.map(function (item) {
					const active = props.value === item.key;
					return h("button", {
						key: item.key, type: "button", role: "tab", "aria-selected": active,
						"data-active": active ? "true" : "false",
						style: Object.assign({}, C.tabButton, {
							borderBottom: "none", marginBottom: 0,
							color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-tertiary)",
							fontWeight: active ? 600 : 400,
						}),
						onClick: () => props.onChange(item.key),
					}, item.label);
				}),
				indicator ? h("div", {
					"aria-hidden": "true",
					style: {
						position: "absolute", left: indicator.left + "px", width: indicator.width + "px",
						bottom: "-1px", height: "2px", borderRadius: "1px",
						background: "var(--dsw-alias-button-primary-fill)",
						transition: "left .18s ease, width .18s ease",
					},
				}) : null,
			);
		}

		function UsageInline(props) {
			const result = props.result;
			if (!result) return null;
			if (!usageSucceeded(result)) {
				return h("span", { title: usageFailure(result) }, "用量查询失败");
			}
			const tiers = usageTiers(result);
			const parts = [];
			if (tiers.length > 0) {
				tiers.forEach(function (tier, index) {
					const label = tierShortName(tier.name) || "额度" + (index + 1);
					parts.push(h("span", {
						key: label + ":" + index,
						title: (tier.name || "套餐额度") + " · 剩余 " + fmt(tier.remaining) + "%"
							+ (tier.nextResetTime ? " · 重置 " + fmtTime(tier.nextResetTime) : ""),
						style: { color: remainingTone(tier.remaining) },
					}, label + " 剩余 " + fmt(tier.remaining) + "%"));
				});
			} else if (number(result.remaining) !== undefined) {
				const tone = result.unit === "%" ? remainingTone(result.remaining) : undefined;
				parts.push(h("span", {
					key: "remaining",
					style: tone ? { color: tone } : {},
				}, "剩余 " + fmt(result.remaining) + (result.unit ? " " + result.unit : "")));
			} else {
				return h("span", null, resultText(result));
			}
			const children = [];
			if (result.planName) children.push(result.planName, " · ");
			parts.forEach(function (part, index) {
				if (index > 0) children.push(h("span", { key: "sep" + index, style: C.separator }, " · "));
				children.push(part);
			});
			return h("span", null, children);
		}

		function UsagePlanDetails(props) {
			const tiers = usageTiers(props.result);
			if (tiers.length === 0) return null;
			return h("div", { style: C.usageTierGrid }, tiers.map(function (tier, index) {
				const used = Math.max(0, Math.min(100, Number(tier.used) || 0));
				const remaining = number(tier.remaining) === undefined ? 100 - used : Math.max(0, Math.min(100, Number(tier.remaining)));
				return h("div", { key: String(tier.name || index), style: C.usageTier },
					h("div", { style: C.usageTierHead },
						h("strong", null, tier.name || "套餐额度"),
						h("span", { style: C.meta }, "已用 " + fmt(used) + "%"),
					),
					h("div", { style: C.bar, title: "剩余 " + fmt(remaining) + "%" }, h("div", { style: {
						width: remaining + "%", height: "100%",
						background: remainingTone(remaining) || "var(--dsw-alias-state-success-primary)",
						transition: "width .25s ease",
					} })),
					h("span", {
						style: Object.assign({}, C.meta, remainingTone(remaining)
							? { color: remainingTone(remaining), fontWeight: 600 }
							: {}),
					}, "剩余 " + fmt(remaining) + "%" + (tier.nextResetTime ? " · 重置 " + fmtTime(tier.nextResetTime) : "")),
				);
			}));
		}

		function GuardianSummary(props) {
			const snapshot = useGuardian(props);
			const provider = providerState(snapshot, props.provider);
			const [busy, setBusy] = react.useState(false);
			const [usageStarted, setUsageStarted] = react.useState(0);
			const [feedback, setFeedback] = react.useState({ kind: "", text: "" });
			const timeoutRef = react.useRef(0);
			const usageBaselineRef = react.useRef(0);
			const healthText = !provider.health ? "未检测" : provider.health.ok ? "可用" : "不可用";
			const usageConfigured = provider.script && provider.script.code;
			const showUsage = !provider.script || provider.script.showInProvider !== false;
			const resultQueriedAt = provider.result ? number(provider.result.queriedAt) || 0 : 0;
			const resultSucceeded = usageSucceeded(provider.result);
			const resultSummary = provider.result ? resultText(provider.result) : "";
			const resultFailure = provider.result ? usageFailure(provider.result) : "";
			react.useEffect(() => () => {
				if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
			}, []);
			react.useEffect(() => {
				if (!usageStarted || resultQueriedAt <= usageBaselineRef.current || resultQueriedAt < usageStarted) return;
				if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
				timeoutRef.current = 0;
				usageBaselineRef.current = 0;
				setUsageStarted(0);
				setBusy(false);
				setFeedback(resultSucceeded
					? { kind: "success", text: "刷新成功：" + resultSummary }
					: { kind: "error", text: "刷新失败：" + resultFailure });
			}, [usageStarted, resultQueriedAt, resultSucceeded, resultSummary, resultFailure]);
			const triggerUsage = async () => {
				if (!usageConfigured || busy) return;
				const startedAt = Date.now();
				usageBaselineRef.current = resultQueriedAt;
				setBusy(true);
				setUsageStarted(startedAt);
				setFeedback({ kind: "pending", text: "正在查询套餐用量…" });
				if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
				timeoutRef.current = window.setTimeout(() => {
					setUsageStarted((currentStart) => {
						if (currentStart !== startedAt) return currentStart;
						usageBaselineRef.current = 0;
						setBusy(false);
						setFeedback({ kind: "error", text: "刷新失败：用量查询超时" });
						return 0;
					});
				}, 35000);
				try {
					await props.mutate([{ op: "set", path: ["usageRunRequests", props.provider], value: startedAt }]);
				} catch (error) {
					if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
					timeoutRef.current = 0;
					usageBaselineRef.current = 0;
					setUsageStarted(0);
					setBusy(false);
					setFeedback({ kind: "error", text: "刷新失败：" + friendlyUsageError(messageOf(error)) });
				}
			};
			if (snapshot.loading) return h("div", { style: C.summary }, "守护状态加载中…");
			return h("div", { style: C.summary },
				h("span", { style: Object.assign({}, C.dot, { background: statusDot(provider.health) }), "aria-hidden": "true" }),
				h("span", { title: provider.health && !provider.health.ok ? provider.health.error : "" }, healthText),
				showUsage ? h("span", { style: C.separator }, "·") : null,
				showUsage ? h("span", null, "本地已用 " + fmt(number(provider.quota.usedTokens) || 0) + " tokens") : null,
				showUsage && provider.quota.limitTokens
					? h("span", null, " / " + fmt(provider.quota.limitTokens))
					: null,
				showUsage && provider.result ? h("span", { style: C.separator }, "·") : null,
				showUsage && provider.result ? h(UsageInline, { result: provider.result }) : null,
				showUsage && usageConfigured
					? h(TooltipHost, { label: "刷新用量" }, h("button", {
						type: "button", style: Object.assign({}, C.refresh, busy ? C.disabled : {}),
						disabled: busy, "aria-label": "刷新 " + props.displayName + " 的用量",
						onClick: triggerUsage,
					}, busy ? "…" : h(RefreshIcon)))
					: null,
				showUsage && provider.result && resultQueriedAt
					? h("span", { title: "最后刷新时间 " + fmtTime(resultQueriedAt) }, fmtTime(resultQueriedAt))
					: null,
				showUsage && feedback.kind === "error" && feedback.text ? h("span", { style: C.separator }, "·") : null,
				showUsage && feedback.kind === "error" && feedback.text ? h("span", {
					role: "status", "aria-live": "polite", title: feedback.text,
					style: { color: "var(--dsw-alias-state-error-primary)" },
				}, feedback.text) : null,
				provider.guardianEnabled ? null : h("span", { style: { color: "var(--dsw-alias-state-warn-label)" } }, "守护已停用"),
				snapshot.error ? h("span", { style: { color: "var(--dsw-alias-state-error-primary)" } }, snapshot.error) : null,
			);
		}

		function GuardianAction(props) {
			const snapshot = useGuardian(props);
			const live = providerState(snapshot, props.provider);
			const [open, setOpen] = react.useState(false);
			const [probeStarted, setProbeStarted] = react.useState(0);
			const [probeBusy, setProbeBusy] = react.useState(false);
			const [probeError, setProbeError] = react.useState("");
			const [probeNotice, setProbeNotice] = react.useState(null);
			react.useEffect(() => {
				if (!probeNotice) return undefined;
				const timer = window.setTimeout(() => setProbeNotice(null), probeNotice.kind === "ok" ? 2000 : 8000);
				return () => window.clearTimeout(timer);
			}, [probeNotice]);
			react.useEffect(() => {
				if (!open) return undefined;
				const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [open]);
			const showProbeNotice = (kind, text) => {
				setProbeNotice({ kind: kind, text: text });
			};
			react.useEffect(() => {
				if (!probeStarted || !live.health || live.health.checkedAt < probeStarted) return;
				setProbeStarted(0);
				setProbeBusy(false);
				setProbeError(live.health.ok ? "" : live.health.error || "连通检测失败");
				showProbeNotice(
					live.health.ok ? "ok" : "error",
					live.health.ok
						? props.displayName + " 接口连通正常 · " + fmtTime(live.health.checkedAt)
						: (live.health.error || "连通检测失败"),
				);
			}, [probeStarted, live.health]);
			const triggerProbe = async () => {
				if (probeBusy || snapshot.loading) return;
				const startedAt = Date.now();
				setProbeStarted(startedAt);
				setProbeBusy(true);
				setProbeError("");
				setProbeNotice(null);
				try {
					await props.mutate([{ op: "set", path: ["probeRequests", props.provider], value: startedAt }]);
					window.setTimeout(() => {
						setProbeStarted((currentStart) => {
							if (currentStart !== startedAt) return currentStart;
							setProbeBusy(false);
							setProbeError("连通检测超时");
							showProbeNotice("error", "连通检测超时，Provider 未在 25 秒内返回结果");
							return 0;
						});
					}, 25000);
				} catch (error) {
					setProbeStarted(0);
					setProbeBusy(false);
					setProbeError(messageOf(error));
					showProbeNotice("error", messageOf(error));
				}
			};
			const previousProbeError = !probeError && live.health && !live.health.ok ? live.health.error || "连通检测失败" : "";
			const probeTooltip = probeBusy
				? "连通测试 · 检测中…"
				: probeError || previousProbeError
					? "连通测试 · 失败：" + (probeError || previousProbeError)
					: live.health && live.health.ok
						? "连通测试 · 上次检测可用"
						: "连通测试";
			const probeColor = probeError || previousProbeError
				? "var(--dsw-alias-state-error-primary)"
				: live.health && live.health.ok
					? "var(--dsw-alias-state-success-primary)"
					: undefined;
			return h(react.Fragment, null,
				h(TooltipHost, { label: probeTooltip },
					h("button", {
						type: "button",
						style: Object.assign({}, C.iconButton, probeColor ? { color: probeColor } : {}, probeBusy ? C.disabled : {}),
						disabled: probeBusy || snapshot.loading,
						"aria-label": "检测 " + props.displayName + " 连通性",
						onClick: triggerProbe,
					}, probeBusy ? "…" : h(ActivityIcon))),
				h(TooltipHost, { label: "模型用量统计" },
					h("button", {
						type: "button", style: C.iconButton, "aria-label": "打开 " + props.displayName + " 的模型用量统计",
						onClick: () => setOpen(true),
					}, h(BarChartIcon))),
				open ? reactDom.createPortal(h(GuardianDialog, Object.assign({}, props, { snapshot, onClose: () => setOpen(false) })), document.body) : null,
				h(BottomNotice, {
					notice: probeNotice ? {
						kind: probeNotice.kind,
						title: probeNotice.kind === "ok" ? "连通测试通过" : "连通测试失败",
						text: probeNotice.text,
					} : null,
					onClose: () => setProbeNotice(null),
				}),
			);
		}

		function GuardianDialog(props) {
			const current = providerState(props.snapshot, props.provider);
			const initialScript = current.script || {};
			const initialCode = props.provider === "zai-coding-cn"
				&& (!initialScript.code || initialScript.code.includes("{{baseUrl}}/usage"))
				? defaultScript(props.provider)
				: initialScript.code || defaultScript(props.provider);
			const [tab, setTab] = react.useState("stats");
			const [guardianEnabled, setGuardianEnabled] = react.useState(current.guardianEnabled);
			const [limit, setLimit] = react.useState(number(current.quota.limitTokens) === undefined ? "" : String(current.quota.limitTokens));
			const [scriptEnabled, setScriptEnabled] = react.useState(initialScript.enabled === true);
			const [showInProvider, setShowInProvider] = react.useState(initialScript.showInProvider !== false);
			const [code, setCode] = react.useState(initialCode);
			const [timeoutSeconds, setTimeoutSeconds] = react.useState(String(Math.round((number(initialScript.timeoutMs) || 10000) / 1000)));
			const [autoMinutes, setAutoMinutes] = react.useState(initialScript.autoQueryIntervalMs ? String(initialScript.autoQueryIntervalMs / 60000) : "0");
			const [busy, setBusy] = react.useState("");
			const [notice, setNotice] = react.useState({ kind: "", text: "" });
			const [usageStarted, setUsageStarted] = react.useState(0);
			const [actionNotice, setActionNotice] = react.useState(null);
			const [defaultModelInfo, setDefaultModelInfo] = react.useState(null);
			const queryTimeoutRef = react.useRef(0);
			const queryBaselineRef = react.useRef(0);
			const live = providerState(props.snapshot, props.provider);
			const liveResultQueriedAt = live.result ? number(live.result.queriedAt) || 0 : 0;
			const liveResultSucceeded = usageSucceeded(live.result);
			const liveResultFailure = live.result ? usageFailure(live.result) : "";

			react.useEffect(() => () => {
				if (queryTimeoutRef.current) window.clearTimeout(queryTimeoutRef.current);
			}, []);
			react.useEffect(() => {
				if (!actionNotice) return undefined;
				const timer = window.setTimeout(() => setActionNotice(null), actionNotice.kind === "ok" ? 2000 : 4000);
				return () => window.clearTimeout(timer);
			}, [actionNotice]);
			react.useEffect(() => {
				let cancelled = false;
				if (typeof props.readDefaultModel !== "function") return undefined;
				props.readDefaultModel().then((info) => {
					if (cancelled) return;
					setDefaultModelInfo(info || null);
				}).catch(() => {});
				return () => { cancelled = true; };
			}, [props.readDefaultModel]);
			react.useEffect(() => {
				if (!usageStarted || liveResultQueriedAt <= queryBaselineRef.current || liveResultQueriedAt < usageStarted) return;
				if (queryTimeoutRef.current) window.clearTimeout(queryTimeoutRef.current);
				queryTimeoutRef.current = 0;
				queryBaselineRef.current = 0;
				setUsageStarted(0);
				setBusy("");
				setNotice(liveResultSucceeded
					? { kind: "", text: "" }
					: { kind: "error", text: "用量查询失败：" + liveResultFailure });
			}, [usageStarted, liveResultQueriedAt, liveResultSucceeded, liveResultFailure]);

			function buildConfig() {
				const timeout = Number(timeoutSeconds);
				const auto = Number(autoMinutes);
				if (!Number.isFinite(timeout) || timeout < 2 || timeout > 30) throw new Error("请求超时需为 2–30 秒。");
				if (!Number.isFinite(auto) || auto < 0 || (auto > 0 && auto < 1)) throw new Error("自动刷新需为 0（关闭）或至少 1 分钟。");
				if (code.trim() === "") throw new Error("用量查询脚本不能为空。");
				return {
					enabled: scriptEnabled,
					showInProvider,
					code,
					timeoutMs: Math.round(timeout * 1000),
					autoQueryIntervalMs: auto === 0 ? 0 : Math.round(auto * 60000),
				};
			}

			function buildSaveOps() {
				const rawLimit = limit.trim();
				const ops = [
					{ op: "set", path: ["enabled"], value: guardianEnabled },
					{ op: "set", path: ["usageScripts", props.provider], value: buildConfig() },
				];
				if (rawLimit === "") {
					if (number(live.quota.limitTokens) !== undefined) ops.push({ op: "unset", path: ["providers", props.provider, "limitTokens"] });
				} else {
					const parsed = Number(rawLimit);
					if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) throw new Error("token 额度必须是正整数。");
					ops.push({ op: "set", path: ["providers", props.provider, "limitTokens"], value: parsed });
				}
				return ops;
			}

			async function perform(kind, task) {
				if (busy) return;
				setBusy(kind);
				setNotice({ kind: "", text: "" });
				try {
					await task();
				} catch (error) {
					if (kind === "script") {
						if (queryTimeoutRef.current) window.clearTimeout(queryTimeoutRef.current);
						queryTimeoutRef.current = 0;
						queryBaselineRef.current = 0;
						setUsageStarted(0);
					}
					setBusy("");
					setNotice({ kind: "error", text: kind === "script" ? "用量查询失败：" + friendlyUsageError(messageOf(error)) : messageOf(error) });
				}
			}

			const save = () => perform("save", async () => {
				await props.mutate(buildSaveOps());
				setBusy("");
				setActionNotice({ kind: "ok", title: "配置已保存", text: props.displayName + " 的用量查询配置已保存" });
			});
			const resetUsage = () => perform("reset", async () => {
				await props.mutate([{ op: "set", path: ["providers", props.provider, "usedTokens"], value: 0 }]);
				setBusy("");
				setActionNotice({ kind: "ok", title: "用量已重置", text: props.displayName + " 的本地 token 用量已清零" });
			});
			const testScript = () => perform("script", async () => {
				const startedAt = Date.now();
				queryBaselineRef.current = liveResultQueriedAt;
				setUsageStarted(startedAt);
				setNotice({ kind: "", text: "" });
				if (queryTimeoutRef.current) window.clearTimeout(queryTimeoutRef.current);
				queryTimeoutRef.current = window.setTimeout(() => {
					setUsageStarted((currentStart) => {
						if (currentStart !== startedAt) return currentStart;
						queryBaselineRef.current = 0;
						setBusy("");
						setNotice({ kind: "error", text: "用量查询失败：请求超时" });
						return 0;
					});
				}, 35000);
				await props.mutate([
					{ op: "set", path: ["usageScripts", props.provider], value: buildConfig() },
					{ op: "set", path: ["usageRunRequests", props.provider], value: startedAt },
				]);
			});

			const pct = live.quota.limitTokens
				? Math.min(100, Math.round((number(live.quota.usedTokens) || 0) / live.quota.limitTokens * 100))
				: 0;
			const disabledStyle = busy ? C.disabled : {};

			return h("div", {
				style: C.overlay,
				onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) props.onClose(); },
			}, h("section", { style: C.panel, role: "dialog", "aria-modal": "true", "aria-labelledby": "guardian-dialog-title" },
				h("div", { style: C.titleRow },
					h("div", null,
						h("h2", { id: "guardian-dialog-title", style: C.title }, props.displayName + " · 模型用量统计"),
							h("p", { style: C.subtitle }, props.active ? "当前 Provider 已挂载" : "当前 Provider 未挂载"),
					),
					h("button", { type: "button", style: C.close, disabled: Boolean(busy), onClick: props.onClose, "aria-label": "关闭" }, "×"),
				),
				h(TabsBar, {
					label: "模型用量统计视图",
					tabs: [{ key: "stats", label: "统计" }, { key: "settings", label: "设置" }],
					value: tab,
					onChange: setTab,
				}),
				props.snapshot.error ? h("p", { style: C.error }, props.snapshot.error) : null,
				tab === "stats"
					? h("div", { style: C.tabBody, role: "tabpanel" },
						h("div", { style: C.queryToolbar },
							h("div", { style: C.switchCopy },
								h("strong", { style: { fontSize: "13px" } }, "用量查询"),
								h("span", { style: C.meta, title: live.result && !liveResultSucceeded ? liveResultFailure : "" },
									live.result
										? h(react.Fragment, null,
											h(UsageInline, { result: live.result }),
											" · 更新于 " + fmtTime(live.result.queriedAt))
										: "尚未查询 Provider 用量",
								),
							),
							h("button", {
								type: "button", style: Object.assign({}, C.button, C.primary, disabledStyle),
								disabled: Boolean(busy), onClick: testScript,
							}, busy === "script" ? "查询中…" : "立即查询用量"),
							),
							notice.kind === "error" && notice.text
								? h("p", { role: "status", "aria-live": "polite", style: C.error }, notice.text)
								: live.result && !liveResultSucceeded
									? h("p", { role: "status", style: C.error }, "上次查询失败：" + liveResultFailure)
									: null,
							h(UsagePlanDetails, { result: liveResultSucceeded ? live.result : null }),
					)
					: h("div", { style: C.tabBody, role: "tabpanel" },
						h("div", { style: C.card },
							h("h3", { style: C.cardTitle }, "用量查询设置"),
							h("label", { style: C.switchRow },
								h("span", { style: C.switchCopy },
									h("span", { style: C.label }, "启用用量查询"),
									h("span", { style: C.meta }, "按自动刷新间隔查询 Provider 的余额或套餐用量"),
								),
								h("input", { type: "checkbox", checked: scriptEnabled, disabled: Boolean(busy), onChange: (event) => setScriptEnabled(event.target.checked) }),
							),
							h("label", { style: C.switchRow },
								h("span", { style: C.switchCopy },
									h("span", { style: C.label }, "在 Provider 卡片展示用量"),
									h("span", { style: C.meta }, "关闭后卡片仅保留连通状态"),
								),
								h("input", { type: "checkbox", checked: showInProvider, disabled: Boolean(busy), onChange: (event) => setShowInProvider(event.target.checked) }),
							),
							h("div", { style: C.settingGrid },
								h("label", { style: C.settingItem },
									h("span", { style: C.label }, "请求超时（秒）"),
									h("input", { style: Object.assign({}, C.input, { width: "100%" }), type: "number", min: 2, max: 30, value: timeoutSeconds, disabled: Boolean(busy), onChange: (event) => setTimeoutSeconds(event.target.value) }),
								),
								h("label", { style: C.settingItem },
									h("span", { style: C.label }, "自动刷新（分钟）"),
									h("input", { style: Object.assign({}, C.input, { width: "100%" }), type: "number", min: 0, step: 1, value: autoMinutes, disabled: Boolean(busy), onChange: (event) => setAutoMinutes(event.target.value) }),
									h("span", { style: C.meta }, "填写 0 表示关闭自动刷新"),
								),
							),
						),
						h("div", { style: C.card },
							h("h3", { style: C.cardTitle }, "本地额度设置"),
							h("label", { style: C.switchRow },
								h("span", { style: C.switchCopy },
									h("span", { style: C.label }, "启用本地额度守护"),
									h("span", { style: C.meta }, "额度超限或 Provider 不可用时拦截新请求"),
								),
								h("input", { type: "checkbox", checked: guardianEnabled, disabled: Boolean(busy), onChange: (event) => setGuardianEnabled(event.target.checked) }),
							),
							h("div", { style: C.fieldRow },
								h("span", { style: C.label }, "本地已用 " + fmt(number(live.quota.usedTokens) || 0) + " tokens"),
								live.quota.limitTokens ? h("span", { style: C.label }, " / 限额 " + fmt(live.quota.limitTokens) + "（" + pct + "%）") : h("span", { style: C.label }, " / 不限额"),
							),
							live.quota.limitTokens ? h("div", { style: C.bar }, h("div", { style: { width: pct + "%", height: "100%", background: pct >= 100 ? "var(--dsw-alias-state-error-primary)" : pct >= 80 ? "var(--dsw-alias-state-warn-label)" : "var(--dsw-alias-state-success-primary)" } })) : null,
							h("div", { style: C.fieldRow },
								h("input", { style: C.input, type: "text", inputMode: "numeric", value: limit, disabled: Boolean(busy), placeholder: "额度上限（留空不限）", "aria-label": "token 额度上限", onChange: (event) => setLimit(event.target.value) }),
								h("button", { type: "button", style: Object.assign({}, C.button, C.danger, disabledStyle), disabled: Boolean(busy), onClick: resetUsage }, busy === "reset" ? "重置中…" : "重置本地用量"),
							),
						),
					),
				tab === "settings" && notice.kind === "error" && notice.text ? h("p", { role: "status", style: C.error }, notice.text) : null,
				tab === "settings" ? h("div", { style: C.footer },
					h("button", { type: "button", style: Object.assign({}, C.button, C.primary, disabledStyle), disabled: Boolean(busy), onClick: save }, busy === "save" ? "保存中…" : "保存配置"),
				) : null,
			),
			h(BottomNotice, { notice: actionNotice, onClose: () => setActionNotice(null) }),
			);
		}

		function getPath(obj, path) {
			let cur = obj;
			for (const key of path) {
				if (cur == null || typeof cur !== "object") return undefined;
				cur = cur[key];
			}
			return cur;
		}
		function installProviderCardFallback(source, readDefaultModel) {
			const mounted = new Map();
			let timer = 0;
			let stopped = false;

			function remove(record) {
				try { record.actionRoot.unmount(); } catch {}
				try { record.summaryRoot.unmount(); } catch {}
				record.actionHost.remove();
				record.summaryHost.remove();
				mounted.delete(record.editButton);
			}

			function providerInfo(editButton, header) {
				let raw = String(editButton.getAttribute("aria-label") || editButton.getAttribute("title") || "").replace(/^编辑\s*/, "").trim();
				if (!raw || raw === "编辑") {
					const labelNode = [...header.children].find((node) => node !== editButton
						&& node.getAttribute("data-llm-guardian-fallback") === null
						&& node.tagName !== "BUTTON"
						&& String(node.textContent || "").trim());
					raw = labelNode ? String(labelNode.textContent || "").trim() : "";
					if (!raw) raw = String(header.textContent || "").replace(/编辑|删除/g, "").trim();
				}
				const match = raw.match(/^(.*)\s+\(([^()]+)\)$/);
				const resolved = match
					? { displayName: match[1].trim(), provider: match[2].trim() }
					: { displayName: raw, provider: raw };
				if (resolved.provider === "DeepSeek") resolved.provider = "deepseek-official";
				return resolved;
			}

			function scan() {
				timer = 0;
				if (stopped) return;
				for (const record of [...mounted.values()]) {
					if (!record.editButton.isConnected || !record.actionHost.isConnected) remove(record);
				}
				for (const editButton of [...document.querySelectorAll('button, [role="button"], [title], [aria-label]')].filter((button) => {
					const label = String(button.getAttribute("aria-label") || "").trim();
					const text = String(button.textContent || "").trim();
					const title = String(button.getAttribute("title") || "").trim();
					return label.startsWith("编辑") || text === "编辑" || title.startsWith("编辑");
				})) {
					const header = editButton.parentElement;
					const card = header && header.parentElement;
					if (!header || !card) continue;
					const nativeAction = [...header.querySelectorAll('button')].some((button) => {
						if (button.closest('[data-llm-guardian-fallback="actions"]')) return false;
						return String(button.getAttribute("aria-label") || "").includes("模型用量统计");
					});
					const existing = mounted.get(editButton);
					if (nativeAction) {
						if (existing) remove(existing);
						continue;
					}
					if (existing) continue;
					const info = providerInfo(editButton, header);
					if (!info.provider) continue;

					const actionHost = document.createElement("span");
					actionHost.dataset.llmGuardianFallback = "actions";
					actionHost.style.display = "inline-flex";
					actionHost.style.alignItems = "center";
					header.insertBefore(actionHost, editButton);

					const summaryHost = document.createElement("div");
					summaryHost.dataset.llmGuardianFallback = "summary";
					summaryHost.style.padding = "0 14px 8px";
					card.insertAdjacentElement("afterend", summaryHost);

					const shared = {
						provider: info.provider,
						displayName: info.displayName,
						active: true,
						hooks: { guardian: source },
						useGuardian: (selector) => react.useSyncExternalStore(
							source.subscribe,
							() => selector(source.getSnapshot()),
							() => selector(source.getSnapshot()),
						),
						load: source.load,
						mutate: source.mutate,
						readDefaultModel,
					};
					const actionRoot = reactClient.createRoot(actionHost);
					const summaryRoot = reactClient.createRoot(summaryHost);
					actionRoot.render(h(GuardianAction, shared));
					summaryRoot.render(h(GuardianSummary, shared));
					mounted.set(editButton, { editButton, actionHost, summaryHost, actionRoot, summaryRoot });
				}
			}

			function schedule() {
				if (timer || stopped) return;
				timer = window.setTimeout(scan, 80);
			}

			const observer = new MutationObserver(schedule);
			observer.observe(document.body, { childList: true, subtree: true });
			schedule();
			return () => {
				stopped = true;
				observer.disconnect();
				if (timer) window.clearTimeout(timer);
				for (const record of [...mounted.values()]) remove(record);
			};
		}

		const inject = ["slots", "connection", "remote"];

		function apply(ctx) {
			const slots = ctx.get("slots");
			const connection = ctx.get("connection");
			const remote = ctx.get("remote");
			if (!slots || !connection || !connection.api || !remote) return;
			const source = createGuardianSource();
		const readDefaultModel = async () => {
			const response = await connection.api.settings.describe({});
			if (!response.result.ok) throw new Error(response.result.error.message);
			const namespace = response.result.value.namespaces.find((item) => item.ns === "agent-default-model");
			const value = namespace && namespace.value && typeof namespace.value === "object" ? namespace.value : {};
			return {
				provider: typeof value.provider === "string" ? value.provider : "",
				model: typeof value.model === "string" ? value.model : "",
			};
		};
			ctx.effect(() => remote.$on("settings/document-updated", (namespace) => {
				if (namespace === NS) void source.load(true);
			}), "llm-guardian: settings invalidations");
			ctx.effect(() => ctx.on("connection/reset", () => { void source.load(true); }), "llm-guardian: connection reset");
			ctx.effect(() => installProviderCardFallback(source, readDefaultModel), "llm-guardian: provider card compatibility");
			slots.inject("settings.models.provider.action", () => slots.register({
				name: "settings.models.provider.action",
				id: "llm-guardian",
				order: -20,
				inject: () => ({ hooks: { guardian: source }, load: source.load, mutate: source.mutate, readDefaultModel }),
			}, GuardianAction));
			slots.inject("settings.models.provider.summary", () => slots.register({
				name: "settings.models.provider.summary",
				id: "llm-guardian",
				order: 0,
				inject: () => ({ hooks: { guardian: source }, load: source.load, mutate: source.mutate }),
			}, GuardianSummary));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
