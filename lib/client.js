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
		const RANGES = [7, 30, 90];
		const DAY_MS = 86400000;
		const PALETTE = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#b07aa1", "#edc948", "#9c755f"];
		const HEAT = ["var(--dsw-alias-bg-layer-1)", "#3c496a", "#536bb0", "#6b8efe", "#93b0ff"];

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
			const statsSnapshot = guardianValue(props.snapshot).stats;

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
							h(ProviderStatsPanel, {
								stats: statsSnapshot,
								provider: props.provider,
								defaultModel: defaultModelInfo && defaultModelInfo.provider === props.provider
									? defaultModelInfo.model
									: "",
							}),
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
		function dayKeyOf(ms) {
			const d = new Date(ms);
			const p = (x) => String(x).padStart(2, "0");
			return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
		}
		function shortDate(key) {
			const parts = key.split("-");
			return parts[1] + "/" + parts[2];
		}

		const S = {
			page: {
				width: "100%", maxWidth: "1080px", boxSizing: "border-box", paddingBottom: "20px",
				display: "flex", flexDirection: "column", gap: "20px", color: "var(--dsw-alias-label-primary)",
			},
			header: {
				display: "flex", alignItems: "flex-end", gap: "18px", minHeight: "44px",
				borderBottom: "1px solid var(--dsw-alias-border-l2)",
			},
			title: { margin: "0 0 12px", fontSize: "24px", fontWeight: 650, lineHeight: "32px", letterSpacing: "-0.02em" },
			headerTab: {
				marginBottom: "-1px", padding: "0 2px 12px", borderBottom: "2px solid var(--dsw-alias-label-primary)",
				fontSize: "13px", fontWeight: 550, color: "var(--dsw-alias-label-primary)",
			},
			filterRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" },
			filterLabel: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" },
			filterActions: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" },
			modelFilter: { display: "inline-flex", alignItems: "center", gap: "7px" },
			filterSelect: {
				height: "34px", boxSizing: "border-box", maxWidth: "220px", minWidth: "130px",
				border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px", padding: "0 30px 0 10px",
				background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: "12px",
			},
			segmented: {
				display: "inline-flex", alignItems: "center", padding: "3px", gap: "2px",
				border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px",
				background: "var(--dsw-alias-bg-module-platform)",
			},
			segmentButton: {
				height: "28px", padding: "0 12px", border: "none", borderRadius: "6px", cursor: "pointer",
				background: "transparent", color: "var(--dsw-alias-label-tertiary)", font: "inherit", fontSize: "12px",
			},
			segmentActive: {
				background: "var(--dsw-alias-interactive-bg-hover-solid)", color: "var(--dsw-alias-label-primary)",
				boxShadow: "0 1px 2px rgba(0,0,0,.12)",
			},
			refreshButton: {
				width: "34px", height: "34px", padding: 0, border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "8px", background: "var(--dsw-alias-bg-module-platform)",
				color: "var(--dsw-alias-label-secondary)", cursor: "pointer", display: "inline-flex",
				alignItems: "center", justifyContent: "center",
			},
			disabled: { opacity: .45, cursor: "default" },
			metricGrid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "10px" },
			metricCard: {
				minHeight: "104px", boxSizing: "border-box", padding: "16px",
				border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "12px",
				background: "var(--dsw-alias-bg-module-platform)", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "14px",
			},
			metricLabelRow: { display: "flex", alignItems: "center", gap: "8px", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" },
			metricIcon: { width: "16px", height: "16px", flex: "none" },
			metricValue: { fontSize: "27px", lineHeight: "32px", fontWeight: 650, letterSpacing: "-0.02em" },
			metricModelValue: { fontSize: "18px", lineHeight: "24px", fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			metricSub: { marginTop: "3px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
			panel: {
				border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "12px", padding: "18px",
				background: "var(--dsw-alias-bg-module-platform)", display: "flex", flexDirection: "column", gap: "16px",
			},
			panelHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" },
			panelTitle: { margin: 0, fontSize: "14px", lineHeight: "20px", fontWeight: 600 },
			intro: { margin: 0, fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
			error: { margin: 0, fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-error-primary)", wordBreak: "break-word" },
			meta: { margin: 0, fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
			legend: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
			legendItem: { display: "inline-flex", alignItems: "center", gap: "5px" },
			legendSwatch: { width: "10px", height: "10px", borderRadius: "3px", flex: "none" },
			modelList: { display: "flex", flexDirection: "column", gap: "12px" },
			modelRow: { display: "grid", gridTemplateColumns: "minmax(120px, 1fr) minmax(150px, 2fr) 92px", alignItems: "center", gap: "12px" },
			modelName: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0, fontSize: "12px" },
			modelNameText: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			modelBar: { height: "7px", borderRadius: "4px", overflow: "hidden", background: "var(--dsw-alias-bg-layer-1)" },
			modelValue: { textAlign: "right", fontSize: "11px", color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap" },
			chartStage: { position: "relative", width: "100%", minWidth: 0 },
			chartSvg: { display: "block", width: "100%", maxWidth: "100%", overflow: "visible" },
			chartTooltip: {
				position: "absolute", zIndex: 20, pointerEvents: "none", boxSizing: "border-box",
				width: "210px", maxWidth: "calc(100% - 16px)", padding: "10px 11px",
				border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "9px",
				background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)",
				boxShadow: "0 8px 24px rgba(0,0,0,.22)", fontSize: "11px", lineHeight: "17px",
			},
			tooltipTitle: { marginBottom: "6px", fontSize: "12px", lineHeight: "18px", fontWeight: 600 },
			tooltipRows: { display: "flex", flexDirection: "column", gap: "3px" },
			tooltipRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
			tooltipLabel: { display: "inline-flex", alignItems: "center", gap: "6px", minWidth: 0, color: "var(--dsw-alias-label-tertiary)" },
			tooltipValue: { textAlign: "right", color: "var(--dsw-alias-label-primary)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
		};

		function DashboardIcon(props) {
			const paths = {
				tokens: ["M13 2 3 14h8l-1 8 11-13h-8z"],
				sessions: ["M4 5h16v11H9l-5 4z", "M8 9h.01", "M12 9h.01", "M16 9h.01"],
				messages: ["M21 12c0 4.4-4 8-9 8a10 10 0 0 1-4.3-1L3 20l1.4-3.7A7 7 0 0 1 3 12c0-4.4 4-8 9-8s9 3.6 9 8z", "M8 12h.01", "M12 12h.01", "M16 12h.01"],
				days: ["M5 5h14a2 2 0 0 1 2 2v12H3V7a2 2 0 0 1 2-2z", "M8 3v4", "M16 3v4", "M3 10h18"],
				streak: ["M9 12l2 2 4-4", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"],
				model: ["M4 4h16v12H4z", "M8 21l4-5 4 5", "M8 11l3-3 3 2 3-4"],
			};
			return h("svg", {
				style: S.metricIcon, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
				strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
			}, (paths[props.kind] || paths.tokens).map(function (d, index) {
				return h("path", { key: index, d: d });
			}));
		}

		function fmtStat(value) {
			const n = Number(value) || 0;
			if (Math.abs(n) >= 100000000) return (n / 100000000).toFixed(n >= 1000000000 ? 1 : 2).replace(/\.0+$/, "") + "亿";
			if (Math.abs(n) >= 10000) return (n / 10000).toFixed(n >= 100000 ? 1 : 2).replace(/\.0+$/, "") + "万";
			return new Intl.NumberFormat("zh-CN").format(n);
		}

		function fmtExactStat(value) {
			return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
		}

		function useChartStageWidth(fallback) {
			const ref = react.useRef(null);
			const [width, setWidth] = react.useState(fallback);
			react.useEffect(function () {
				const node = ref.current;
				if (!node) return undefined;
				function measure() {
					const next = Math.max(280, Math.round(node.getBoundingClientRect().width || fallback));
					setWidth(function (current) { return Math.abs(current - next) > 1 ? next : current; });
				}
				measure();
				if (typeof globalThis.ResizeObserver === "function") {
					const observer = new globalThis.ResizeObserver(measure);
					observer.observe(node);
					return function () { observer.disconnect(); };
				}
				if (typeof globalThis.addEventListener === "function") globalThis.addEventListener("resize", measure);
				return function () {
					if (typeof globalThis.removeEventListener === "function") globalThis.removeEventListener("resize", measure);
				};
			}, [fallback]);
			return [ref, width];
		}

		function showChartTooltip(ref, setTooltip, event, payload) {
			const stage = ref.current;
			if (!stage) return;
			const bounds = stage.getBoundingClientRect();
			const localX = event.clientX - bounds.left;
			const localY = event.clientY - bounds.top;
			const tooltipWidth = Math.min(210, Math.max(160, bounds.width - 16));
			const tooltipHeight = 38 + (payload.rows ? payload.rows.length : 0) * 20;
			let x = localX + 12;
			if (x + tooltipWidth > bounds.width - 8) x = localX - tooltipWidth - 12;
			x = Math.max(8, Math.min(x, Math.max(8, bounds.width - tooltipWidth - 8)));
			let y = localY + 12;
			if (y + tooltipHeight > bounds.height) y = localY - tooltipHeight - 12;
			y = Math.max(8, y);
			setTooltip(Object.assign({}, payload, { x: x, y: y }));
		}

		function ChartTooltip(props) {
			const tooltip = props.tooltip;
			if (!tooltip) return null;
			return h("div", {
				role: "tooltip",
				style: Object.assign({}, S.chartTooltip, { left: tooltip.x + "px", top: tooltip.y + "px" }),
			},
				h("div", { style: S.tooltipTitle }, tooltip.title),
				h("div", { style: S.tooltipRows }, (tooltip.rows || []).map(function (row, index) {
					return h("div", { key: row.label + "-" + index, style: S.tooltipRow },
						h("span", { style: S.tooltipLabel },
							row.color ? h("span", { style: Object.assign({}, S.legendSwatch, { width: "8px", height: "8px", borderRadius: "50%", background: row.color }) }) : null,
							h("span", null, row.label),
						),
						h("span", { style: S.tooltipValue }, row.value),
					);
				})),
			);
		}

		function MetricCard(props) {
			return h("div", { style: S.metricCard },
				h("div", { style: S.metricLabelRow }, h(DashboardIcon, { kind: props.kind }), h("span", null, props.label)),
				h("div", null,
					h("div", { style: props.compact ? S.metricModelValue : S.metricValue, title: props.title || "" }, props.value),
					props.sub ? h("div", { style: S.metricSub }, props.sub) : null,
				),
			);
		}

		function Heatmap(props) {
			const days = props.days || [];
			const rangeDays = props.rangeDays;
			const stageRef = react.useRef(null);
			const [tooltip, setTooltip] = react.useState(null);
			const byDay = react.useMemo(function () {
				return new Map(days.map(function (day) { return [day.date, day]; }));
			}, [days]);
			const today = react.useMemo(function () {
				const now = new Date();
				return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
			}, []);
			const cells = react.useMemo(function () {
				const out = [];
				for (let index = rangeDays - 1; index >= 0; index -= 1) {
					const timestamp = today - index * DAY_MS;
					const key = dayKeyOf(timestamp);
					const record = byDay.get(key);
					out.push({ key: key, timestamp: timestamp, tokens: record ? record.tokens : 0, messages: record ? record.messages : 0 });
				}
				return out;
			}, [byDay, rangeDays, today]);
			const maxTokens = react.useMemo(function () {
				let maximum = 0;
				for (const cell of cells) if (cell.tokens > maximum) maximum = cell.tokens;
				return maximum;
			}, [cells]);
			const firstTimestamp = cells.length ? cells[0].timestamp : today;
			const leading = new Date(firstTimestamp).getDay();
			const slots = Array(leading).fill(null).concat(cells);
			const weeks = Math.ceil(slots.length / 7);
			const cellSize = 9;
			const gap = 2;
			const width = Math.max(weeks * (cellSize + gap), 180);
			return h("section", { style: S.panel },
				h("div", { style: S.panelHeader },
					h("h3", { style: S.panelTitle }, "活跃热力图"),
					h("div", { style: S.legend },
						h("span", null, "较少"),
						HEAT.map(function (color) {
							return h("span", { key: color, style: Object.assign({}, S.legendSwatch, { background: color, border: "1px solid var(--dsw-alias-border-l3)" }) });
						}),
						h("span", null, "较多"),
					),
				),
				h("div", { ref: stageRef, style: S.chartStage, onMouseLeave: function () { setTooltip(null); } },
					h("svg", {
						viewBox: "0 0 " + width + " " + (7 * (cellSize + gap)),
						preserveAspectRatio: "xMinYMin meet",
						style: Object.assign({}, S.chartSvg, { maxWidth: width + "px", height: "auto" }),
						"aria-label": "最近 280 天活跃热力图",
					},
					slots.map(function (cell, index) {
						if (cell === null) return null;
						const column = Math.floor(index / 7);
						const row = index % 7;
						let level = 0;
						if (cell.tokens > 0 && maxTokens > 0) {
							const ratio = cell.tokens / maxTokens;
							level = ratio > .75 ? 4 : ratio > .5 ? 3 : ratio > .25 ? 2 : 1;
						}
						const activity = ["无活动", "较少", "一般", "较多", "高"][level];
						const detail = {
							title: cell.key,
							rows: [
								{ label: "Token 用量", value: fmtExactStat(cell.tokens) },
								{ label: "消息数量", value: fmtExactStat(cell.messages) + " 条" },
								{ label: "活跃程度", value: activity },
							],
						};
						return h("rect", {
							key: cell.key, x: column * (cellSize + gap), y: row * (cellSize + gap),
							width: cellSize, height: cellSize, rx: 3, fill: HEAT[level],
							stroke: "var(--dsw-alias-border-l3)", strokeWidth: level === 0 ? 1 : 0,
							style: { cursor: "crosshair" },
							onMouseEnter: function (event) { showChartTooltip(stageRef, setTooltip, event, detail); },
							onMouseMove: function (event) { showChartTooltip(stageRef, setTooltip, event, detail); },
						}, h("title", null, cell.key + " · " + fmtStat(cell.tokens) + " tokens · " + cell.messages + " 条消息"));
					})),
					h(ChartTooltip, { tooltip: tooltip }),
				),
			);
		}

		function TrendChart(props) {
			const days = props.days || [];
			const rangeDays = props.rangeDays;
			const models = (props.models || []).slice(0, 6);
			const visibleNames = models.map(function (model) { return model.model; });
			const stageMeasure = useChartStageWidth(640);
			const stageRef = stageMeasure[0];
			const stageWidth = stageMeasure[1];
			const [tooltip, setTooltip] = react.useState(null);
			const byDay = react.useMemo(function () {
				return new Map(days.map(function (day) { return [day.date, day]; }));
			}, [days]);
			const series = react.useMemo(function () {
				const now = new Date();
				const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
				const output = [];
				for (let index = rangeDays - 1; index >= 0; index -= 1) {
					const key = dayKeyOf(today - index * DAY_MS);
					const record = byDay.get(key);
					const modelValues = new Map();
					if (record && Array.isArray(record.models)) {
						for (const model of record.models) modelValues.set(model.model, model.tokens);
					}
					output.push({ key: key, tokens: record ? record.tokens : 0, messages: record ? record.messages : 0, modelValues: modelValues });
				}
				return output;
			}, [byDay, rangeDays]);
			let maximum = 1;
			for (const day of series) if (day.tokens > maximum) maximum = day.tokens;
			const padLeft = 10;
			const padRight = 16;
			const padTop = 12;
			const padBottom = 26;
			const width = Math.max(280, stageWidth);
			const innerWidth = Math.max(1, width - padLeft - padRight);
			const innerHeight = 190;
			const height = padTop + innerHeight + padBottom;
			const slot = innerWidth / Math.max(series.length, 1);
			const barWidth = Math.max(2, Math.min(16, slot * .64));
			const grid = [0, .25, .5, .75, 1].map(function (ratio) {
				const y = padTop + innerHeight * (1 - ratio);
				return h("line", {
					key: ratio, x1: padLeft, x2: padLeft + innerWidth, y1: y, y2: y,
					stroke: "var(--dsw-alias-border-l2)", strokeWidth: 1, strokeDasharray: ratio === 0 ? undefined : "4 4",
				});
			});
			const bars = [];
			const hitTargets = [];
			const labels = [];
			const labelEvery = Math.max(1, Math.ceil(series.length / 7));
			series.forEach(function (day, index) {
				const x = padLeft + index * slot + (slot - barWidth) / 2;
				let represented = 0;
				let cursorY = padTop + innerHeight;
				const segments = visibleNames.map(function (name) {
					const tokens = day.modelValues.get(name) || 0;
					represented += tokens;
					return { name: name, tokens: tokens };
				});
				if (segments.every(function (segment) { return segment.tokens === 0; }) && day.tokens > 0) {
					segments.push({ name: visibleNames[0] || "全部模型", tokens: day.tokens });
					represented = day.tokens;
				}
				const other = Math.max(0, day.tokens - represented);
				if (other > 0) segments.push({ name: "其他", tokens: other });
				const detailRows = [
					{ label: "Token 总量", value: fmtExactStat(day.tokens) },
					{ label: "消息数量", value: fmtExactStat(day.messages) + " 条" },
				];
				segments.forEach(function (segment) {
					if (!(segment.tokens > 0)) return;
					const colorIndex = visibleNames.indexOf(segment.name);
					const share = day.tokens > 0 ? segment.tokens / day.tokens * 100 : 0;
					detailRows.push({
						label: segment.name,
						value: fmtExactStat(segment.tokens) + " · " + share.toFixed(1).replace(/\.0$/, "") + "%",
						color: colorIndex >= 0 ? PALETTE[colorIndex % PALETTE.length] : "var(--dsw-alias-label-tertiary)",
					});
				});
				if (detailRows.length === 2) detailRows.push({ label: "模型明细", value: "暂无用量" });
				const detail = { title: day.key, rows: detailRows };
				segments.forEach(function (segment) {
					if (!(segment.tokens > 0)) return;
					const segmentHeight = Math.max(1, segment.tokens / maximum * innerHeight);
					cursorY -= segmentHeight;
					const colorIndex = visibleNames.indexOf(segment.name);
					bars.push(h("rect", {
						key: day.key + "-" + segment.name, x: x, y: cursorY, width: barWidth, height: segmentHeight,
						rx: 2, fill: colorIndex >= 0 ? PALETTE[colorIndex % PALETTE.length] : "var(--dsw-alias-label-tertiary)", pointerEvents: "none",
					}, h("title", null, day.key + " · " + segment.name + " · " + fmtStat(segment.tokens) + " tokens")));
				});
				hitTargets.push(h("rect", {
					key: "hit-" + day.key,
					x: padLeft + index * slot, y: padTop, width: Math.max(slot, 2), height: innerHeight,
					fill: "transparent", style: { cursor: "crosshair" },
					onMouseEnter: function (event) { showChartTooltip(stageRef, setTooltip, event, detail); },
					onMouseMove: function (event) { showChartTooltip(stageRef, setTooltip, event, detail); },
				}, h("title", null, day.key + " · " + fmtExactStat(day.tokens) + " tokens")));
				if (index % labelEvery === 0 || index === series.length - 1) {
					labels.push(h("text", {
						key: "label-" + day.key, x: x + barWidth / 2, y: height - 5, textAnchor: "middle",
						fontSize: 10, fill: "var(--dsw-alias-label-tertiary)",
					}, shortDate(day.key)));
				}
			});
			const hasDailyData = days.some(function (day) {
				return (Number(day.tokens) || 0) > 0 || (Number(day.messages) || 0) > 0;
			});
			return h("section", { style: S.panel },
				h("div", { style: S.panelHeader },
					h("h3", { style: S.panelTitle }, "按天 Token 趋势"),
					h("div", { style: S.legend },
					models.map(function (model, index) {
						return h("span", { key: model.model, style: S.legendItem },
							h("span", { style: Object.assign({}, S.legendSwatch, { borderRadius: "50%", background: PALETTE[index % PALETTE.length] }) }),
							h("span", null, model.model),
						);
					}),
				),
			),
				hasDailyData ? h("div", { ref: stageRef, style: S.chartStage, onMouseLeave: function () { setTooltip(null); } },
					h("svg", {
						width: "100%", height: height, viewBox: "0 0 " + width + " " + height,
						preserveAspectRatio: "none", style: Object.assign({}, S.chartSvg, { height: height + "px" }),
						"aria-label": "最近 " + rangeDays + " 天 Token 趋势",
					},
					grid, bars, hitTargets, labels,
				),
					h(ChartTooltip, { tooltip: tooltip }),
				) : h("p", { style: S.intro }, "暂无按天 Token 明细，刷新统计后即可生成。"),
			);
		}

		function ModelUsage(props) {
			const models = props.models || [];
			const total = models.reduce(function (sum, model) { return sum + model.tokens; }, 0);
			const stageRef = react.useRef(null);
			const [tooltip, setTooltip] = react.useState(null);
			return h("section", { style: S.panel },
				h("div", { style: S.panelHeader },
					h("h3", { style: S.panelTitle }, "模型用量"),
					h("span", { style: S.meta }, total > 0 ? "按 token 占比" : ""),
				),
				models.length === 0 || total <= 0
					? h("p", { style: S.intro }, "暂无模型 token 数据。")
					: h("div", { ref: stageRef, style: S.chartStage, onMouseLeave: function () { setTooltip(null); } },
						h("div", { style: S.modelList }, models.map(function (model, index) {
						const share = model.tokens / total;
						const color = PALETTE[index % PALETTE.length];
						const detail = {
							title: model.model,
							rows: [
								{ label: "排名", value: "第 " + (index + 1) + " 名" },
								{ label: "Token 用量", value: fmtExactStat(model.tokens) },
								{ label: "用量占比", value: (share * 100).toFixed(1).replace(/\.0$/, "") + "%", color: color },
							],
						};
						return h("div", {
							key: model.model, style: Object.assign({}, S.modelRow, { cursor: "default" }),
							title: model.model + " · " + fmtExactStat(model.tokens) + " tokens",
							onMouseEnter: function (event) { showChartTooltip(stageRef, setTooltip, event, detail); },
							onMouseMove: function (event) { showChartTooltip(stageRef, setTooltip, event, detail); },
						},
							h("div", { style: S.modelName },
								h("span", { style: Object.assign({}, S.legendSwatch, { borderRadius: "50%", background: color }) }),
								h("span", { style: S.modelNameText, title: model.model }, model.model),
							),
							h("div", { style: S.modelBar },
								h("div", { style: { width: Math.max(2, share * 100) + "%", height: "100%", borderRadius: "4px", background: color } }),
							),
							h("div", { style: S.modelValue }, Math.round(share * 100) + "% · " + fmtStat(model.tokens)),
							);
						})),
						h(ChartTooltip, { tooltip: tooltip }),
					),
			);
		}

		function modelRecord(day, modelName) {
			if (!day || !Array.isArray(day.models)) return null;
			return day.models.find(function (model) { return model.model === modelName; }) || null;
		}

		function streakForDays(days) {
			const active = new Set((days || []).filter(function (day) {
				return (Number(day.tokens) || 0) > 0 || (Number(day.messages) || 0) > 0;
			}).map(function (day) { return day.date; }));
			const now = new Date();
			let cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
			if (!active.has(dayKeyOf(cursor))) cursor -= DAY_MS;
			let streak = 0;
			while (active.has(dayKeyOf(cursor))) {
				streak += 1;
				cursor -= DAY_MS;
			}
			return streak;
		}

		function filterStatsByModel(stats, modelName) {
			if (!stats || !modelName || modelName === "all") return stats;
			const summary = (stats.models || []).find(function (model) { return model.model === modelName; }) || {};
			function selectDays(source) {
				const selected = [];
				for (const day of source || []) {
					const record = modelRecord(day, modelName);
					if (!record) continue;
					const tokens = Number(record.tokens) || 0;
					const messages = Number(record.messages) || 0;
					if (tokens <= 0 && messages <= 0) continue;
					selected.push({
						date: day.date,
						tokens: tokens,
						messages: messages,
						models: [{ model: modelName, tokens: tokens, messages: messages }],
					});
				}
				return selected;
			}
			const days = selectDays(stats.days || []);
			const heatmapSource = (stats.heatmapDays || []).some(function (day) { return Array.isArray(day.models); })
				? stats.heatmapDays
				: stats.days;
			const heatmapDays = selectDays(heatmapSource || []);
			const summedTokens = days.reduce(function (sum, day) { return sum + day.tokens; }, 0);
			const summedMessages = days.reduce(function (sum, day) { return sum + day.messages; }, 0);
			const totalTokens = number(summary.tokens) === undefined ? summedTokens : summary.tokens;
			const messages = number(summary.messages) === undefined ? summedMessages : summary.messages;
			const sessions = number(summary.sessions) === undefined ? 0 : summary.sessions;
			const selectedSummary = { model: modelName, tokens: totalTokens, messages: messages, sessions: sessions };
			return Object.assign({}, stats, {
				totalTokens: totalTokens,
				sessions: sessions,
				messages: messages,
				activeDays: days.length,
				streak: streakForDays(heatmapDays),
				topModel: {
					model: modelName,
					tokens: totalTokens,
					share: (Number(stats.totalTokens) || 0) > 0 ? totalTokens / stats.totalTokens : 0,
				},
				days: days,
				heatmapDays: heatmapDays,
				models: [selectedSummary],
			});
		}

		function ProviderStatsPanel(props) {
			const stats = props.stats && typeof props.stats === "object" ? props.stats : null;
			const [selectedModel, setSelectedModel] = react.useState("");
			if (!stats) return h("div", { style: C.card }, h("p", { style: C.meta }, "暂无本地模型统计，打开“用量统计”刷新后即可生成。"));
			const modelNames = (stats.models || []).map(function (model) { return model.model; });
			// 默认选中：全局默认模型（Provider 匹配时）> 该 Provider 用量最高的模型 > 全部模型
			const preferredModel = (function () {
				const models = stats.models || [];
				if (models.length === 0) return "all";
				if (props.defaultModel && modelNames.includes(props.defaultModel)) return props.defaultModel;
				const own = models.filter(function (entry) {
					return !entry.provider || !props.provider || entry.provider === props.provider;
				});
				const pool = own.length > 0 ? own : models;
				let top = pool[0];
				for (const entry of pool) if ((entry.tokens || 0) > (top.tokens || 0)) top = entry;
				return top.model;
			})();
			const chosen = selectedModel === "" ? preferredModel : selectedModel;
			const effectiveModel = chosen !== "all" && !modelNames.includes(chosen)
				? (modelNames.includes(preferredModel) ? preferredModel : "all")
				: chosen;
			const view = filterStatsByModel(stats, effectiveModel);
			const missingSelectedDailyBreakdown = effectiveModel !== "all"
				&& (Number(view.totalTokens) || 0) > 0
				&& !(view.days || []).some(function (day) { return (Number(day.tokens) || 0) > 0; });
			return h("div", { style: C.tabBody },
				h("div", { style: Object.assign({}, C.fieldRow, { justifyContent: "space-between" }) },
					h("span", { style: C.label }, "统计模型"),
					h("select", {
						style: C.select, value: effectiveModel, "aria-label": "选择统计模型",
						onChange: function (event) { setSelectedModel(event.target.value); },
					},
						h("option", { value: "all" }, "全部模型"),
						modelNames.map(function (model) { return h("option", { key: model, value: model }, model); }),
					),
				),
				h("div", { style: C.compactStatsGrid },
					h("div", { style: C.compactStat }, h("span", { style: C.meta }, "Token 用量"), h("strong", { style: C.compactStatValue }, fmtStat(view.totalTokens))),
					h("div", { style: C.compactStat }, h("span", { style: C.meta }, "会话数量"), h("strong", { style: C.compactStatValue }, fmtStat(view.sessions))),
					h("div", { style: C.compactStat }, h("span", { style: C.meta }, effectiveModel === "all" ? "消息数量" : "模型消息"), h("strong", { style: C.compactStatValue }, fmtStat(view.messages))),
					h("div", { style: C.compactStat }, h("span", { style: C.meta }, "活跃天数"), h("strong", { style: C.compactStatValue }, fmtStat(view.activeDays))),
				),
				h(TrendChart, { days: view.days || [], models: view.models || [], rangeDays: view.rangeDays || 30 }),
				missingSelectedDailyBreakdown
					? h("p", { style: C.warning }, "当前旧快照缺少该模型的按天明细，请在“用量统计”点击刷新后查看。")
					: null,
				h("p", { style: C.meta }, "按当前筛选模型汇总 · 数据源：本机会话日志"),
			);
		}

		function UsageSection(props) {
			const api = props.api;
			const remote = props.remote;
			const [stats, setStats] = react.useState(null);
			const [range, setRange] = react.useState(30);
			const [selectedModel, setSelectedModel] = react.useState("all");
			const [loading, setLoading] = react.useState(true);
			const [error, setError] = react.useState("");
			const [statsBusy, setStatsBusy] = react.useState(false);
			const generation = react.useRef(0);
			const refreshStartedAt = react.useRef(0);
			const statsBusyRef = react.useRef(false);

			function markBusy(next) {
				statsBusyRef.current = next;
				setStatsBusy(next);
			}

			const load = react.useCallback(async function load() {
				if (!api) return;
				const current = ++generation.current;
				try {
					const value = await guardianRequest();
					if (current !== generation.current) return;
					const snapshot = value.stats && typeof value.stats === "object" ? value.stats : null;
					setStats(snapshot);
					setLoading(false);
					setError("");
					if (snapshot && snapshot.generatedAt >= refreshStartedAt.current) markBusy(false);
					if (!snapshot && !statsBusyRef.current) markBusy(false);
				} catch (loadError) {
					if (current !== generation.current) return;
					setLoading(false);
					setError(loadError instanceof Error ? loadError.message : String(loadError));
					markBusy(false);
				}
			}, []);

			react.useEffect(function () {
				void load();
				if (!remote) return undefined;
				const dispose = remote.$on("settings/document-updated", function (namespace) {
					if (namespace === NS) void load();
				});
				return function () { if (dispose) dispose(); };
			}, [load, remote]);

			async function refreshStats(nextRange) {
				if (!api || statsBusyRef.current) return;
				const target = nextRange || range;
				if (nextRange) setRange(nextRange);
				const startedAt = Date.now();
				refreshStartedAt.current = startedAt;
				markBusy(true);
				setError("");
				try {
					await guardianRequest([
						{ op: "set", path: ["statsRangeDays"], value: target },
						{ op: "set", path: ["statsRefreshAt"], value: startedAt },
					]);
					await load();
				} catch (refreshError) {
					setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
					markBusy(false);
				}
			}

			const bootstrapped = react.useRef(false);
			react.useEffect(function () {
				if (!api || bootstrapped.current) return;
				bootstrapped.current = true;
				void refreshStats(30);
			}, [api]);

			if (!api) return h("div", { style: S.page }, h("p", { style: S.error }, "连接不可用，无法读取用量数据。"));
			const snapshot = stats && typeof stats === "object" ? stats : null;
			const currentStats = snapshot && snapshot.rangeDays === range ? snapshot : null;
			const modelOptions = currentStats ? (currentStats.models || []).map(function (model) { return model.model; }) : [];
			const effectiveModel = selectedModel === "all" || modelOptions.includes(selectedModel) ? selectedModel : "all";
			const displayStats = currentStats ? filterStatsByModel(currentStats, effectiveModel) : null;

			return h("div", { style: S.page },
				h("header", { style: S.header },
					h("h2", { style: S.title }, "用量统计"),
					h("span", { style: S.headerTab }, "应用用量"),
			),
				h("div", { style: S.filterRow },
					h("span", { style: S.filterLabel }, "查询维度"),
					h("div", { style: S.filterActions },
					h("label", { style: S.modelFilter },
						h("span", { style: S.filterLabel }, "模型"),
						h("select", {
							style: S.filterSelect, value: effectiveModel, disabled: statsBusy,
							"aria-label": "选择统计模型",
							onChange: function (event) { setSelectedModel(event.target.value); },
						},
							h("option", { value: "all" }, "全部模型"),
							modelOptions.map(function (model) { return h("option", { key: model, value: model }, model); }),
						),
					),
					h("div", { style: S.segmented }, RANGES.map(function (value) {
					const active = value === range;
					return h("button", {
						key: value, type: "button", disabled: statsBusy,
						style: Object.assign({}, S.segmentButton, active ? S.segmentActive : {}, statsBusy ? S.disabled : {}),
						onClick: function () { void refreshStats(value); },
					}, "最近 " + value + " 天");
				})),
					h("button", {
					type: "button", title: "重新聚合并刷新", "aria-label": "刷新使用统计",
					disabled: statsBusy, style: Object.assign({}, S.refreshButton, statsBusy ? S.disabled : {}),
					onClick: function () { void refreshStats(); },
				}, statsBusy ? "…" : h(RefreshIcon)),
				),
			),
			error ? h("p", { style: S.error }, error) : null,
				!displayStats
					? h("section", { style: S.panel }, h("p", { style: S.intro }, loading || statsBusy ? "正在聚合本机会话日志…" : "暂无统计数据，点击刷新后生成。"))
					: h(react.Fragment, null,
						h("section", { style: S.metricGrid },
							h(MetricCard, { kind: "tokens", label: "tokens 用量", value: fmtStat(displayStats.totalTokens) }),
							h(MetricCard, { kind: "sessions", label: "会话数量", value: fmtStat(displayStats.sessions) }),
							h(MetricCard, { kind: "messages", label: effectiveModel === "all" ? "消息数量" : "模型消息", value: fmtStat(displayStats.messages) }),
							h(MetricCard, { kind: "days", label: "活跃天数", value: fmtStat(displayStats.activeDays) }),
							h(MetricCard, { kind: "streak", label: "当前连续天数", value: fmtStat(displayStats.streak) }),
							h(MetricCard, {
								kind: "model", label: effectiveModel === "all" ? "最常用模型" : "筛选模型", compact: true,
								value: displayStats.topModel ? displayStats.topModel.model : "—",
								title: displayStats.topModel ? displayStats.topModel.model : "",
								sub: displayStats.topModel ? (effectiveModel === "all" ? "占比 " : "总量占比 ") + Math.round(displayStats.topModel.share * 100) + "%" : "",
							}),
						),
						h(Heatmap, {
							days: Array.isArray(displayStats.heatmapDays) && displayStats.heatmapDays.length > 0
								? displayStats.heatmapDays
								: displayStats.days || [],
							rangeDays: 280,
						}),
						h(TrendChart, { days: displayStats.days || [], models: displayStats.models || [], rangeDays: range }),
						h(ModelUsage, { models: displayStats.models || [] }),
						h("p", { style: S.meta }, "生成于 " + fmtTime(currentStats.generatedAt) + " · 数据源：本机会话日志"),
				),
			);
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
			slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "local-usage-stats",
				order: 12,
				label: "用量统计",
				inject: () => ({ api: connection.api, remote }),
			}, UsageSection));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
