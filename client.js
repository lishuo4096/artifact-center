window.__ModuleLoader__.load({
	id: "artifact-center",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		//#region 常量与词典
		/** 词典命名空间（与宿主 locale service 约定一致）。 */
		const NS = "artifactCenter";
		/** 侧边栏行与它所打开的 main 面板共用同一个 id。 */
		const PANEL_ID = "artifacts";
		/** 宿主注册的数据路由前缀（同源，客户端直接 fetch）。 */
		const API = "/artifact-center/api/";

		const zh = {
			panel: "产物中心",
			title: "产物中心",
			refresh: "刷新",
			search: "搜索标题 / 文件名 / 路径 / 备注 / 标签",
			all: "全部",
			empty: "还没有登记任何产物",
			emptyHint: "agent 产出重要文件后会调用 artifact_save 登记到这里；也可以在对话里让它保存某个文件。",
			noMatch: "当前筛选没有匹配项",
			loadError: "无法读取产物索引",
			copyPath: "复制路径",
			reveal: "定位文件",
			remove: "删除",
			confirmRemove: "确认删除",
			cancel: "取消",
			copied: "路径已复制",
			removed: "已删除",
			modeCopy: "副本",
			modeLink: "链接",
			rootDir: "根目录",
			count: "共 {n} 个",
			extLabel: "后缀",
			catLabel: "分类",
			hint: "在对话里说「把这个文件收进产物中心」，agent 就会调用 artifact_save。",
			failed: "操作失败",
			note: "备注",
		};

		const en = {
			panel: "Artifacts",
			title: "Artifact Center",
			refresh: "Refresh",
			search: "Search title / file name / path / note / tags",
			all: "All",
			empty: "No artifacts yet",
			emptyHint: "When the agent produces an important file it registers it here with artifact_save.",
			noMatch: "Nothing matches the current filters",
			loadError: "Cannot read the artifact index",
			copyPath: "Copy path",
			reveal: "Show in folder",
			remove: "Remove",
			confirmRemove: "Confirm",
			cancel: "Cancel",
			copied: "Path copied",
			removed: "Removed",
			modeCopy: "copy",
			modeLink: "link",
			rootDir: "Root",
			count: "{n} total",
			extLabel: "Extension",
			catLabel: "Category",
			hint: 'Say "file this into the Artifact Center" and the agent calls artifact_save.',
			failed: "Action failed",
			note: "Note",
		};
		//#endregion

		//#region 工具函数
		/** 从宿主路由取数据；失败时抛出带可读消息的 Error。 */
		async function api(path, init) {
			let res;
			try {
				res = await fetch(API + path, init);
			} catch (e) {
				throw new Error(`${e && e.message ? e.message : "network error"} — 面板数据走本机 HTTP 路由，请在 Web GUI（http://127.0.0.1:…）中使用。`);
			}
			const data = await res.json().catch(() => null);
			if (data === null) throw new Error(`HTTP ${res.status}`);
			if (!res.ok || data.ok === false) throw new Error(data.message || `HTTP ${res.status}`);
			return data;
		}

		function formatSize(bytes) {
			if (!Number.isFinite(bytes)) return "";
			if (bytes < 1024) return `${bytes} B`;
			if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
			return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
		}

		function formatTime(iso) {
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return "";
			return date.toLocaleString();
		}

		const CATEGORY_LABELS = {
			pdf: "PDF",
			excel: "Excel",
			ppt: "PPT",
			word: "Word",
			image: "图片",
			code: "代码",
			data: "数据",
			archive: "压缩包",
			other: "其他",
		};
		//#endregion

		//#region 侧边栏字形（必须直接渲染 svg，不能再套一层包装元素）
		/** 侧边栏面板行的图标：归档盒。 */
		function ArtifactsPanelIcon(props) {
			const size = props && props.size ? props.size : 16;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
					focusable: "false",
				},
				h("rect", {
					x: 1.75,
					y: 2.75,
					width: 12.5,
					height: 10.5,
					rx: 1.75,
					stroke: "currentColor",
					strokeWidth: 1.2,
				}),
				h("path", {
					d: "M2 6.25h12",
					stroke: "currentColor",
					strokeWidth: 1.2,
					strokeLinecap: "round",
				}),
				h("path", {
					d: "M6.25 9h3.5",
					stroke: "currentColor",
					strokeWidth: 1.2,
					strokeLinecap: "round",
				}),
			);
		}
		//#endregion

		//#region 局部样式（只依赖 --dsw-alias-* 主题 token，随组件卸载消失）
		const STYLE = `
.ac-page{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px}
.ac-head{display:flex;align-items:baseline;gap:8px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.ac-title{font-size:15px;font-weight:600}
.ac-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-btn{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer;line-height:1.6}
.ac-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ac-btn.danger:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.ac-filters{padding:10px 16px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.ac-chiprow{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ac-rowlabel{color:var(--dsw-alias-label-caption);font-size:11px;min-width:34px}
.ac-chip{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 10px;font-size:12px;cursor:pointer}
.ac-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ac-chip[data-on="1"]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}
.ac-chip .ac-count{opacity:.65;margin-left:4px;font-size:11px}
.ac-search{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 9px;font-size:12px;outline:none}
.ac-search:focus{border-color:var(--dsw-alias-brand-primary)}
.ac-body{flex:1;min-height:0;overflow:auto;padding:10px 16px 20px}
.ac-row{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1)}
.ac-row:hover{border-color:var(--dsw-alias-border-l3)}
.ac-cat{flex:none;width:52px;text-align:center;font-size:11px;border-radius:6px;padding:2px 0;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.ac-main{flex:1;min-width:0}
.ac-rowtitle{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-ext{color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:11px;margin-left:6px}
.ac-path{color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:ui-monospace,Consolas,monospace;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.ac-note{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:4px;white-space:pre-wrap;word-break:break-word}
.ac-meta{color:var(--dsw-alias-label-caption);font-size:11px;margin-top:4px;display:flex;gap:8px;flex-wrap:wrap}
.ac-tag{background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:0 5px}
.ac-actions{flex:none;display:flex;flex-direction:column;gap:5px;align-items:stretch}
.ac-empty{color:var(--dsw-alias-label-tertiary);text-align:center;padding:36px 20px;line-height:1.9}
.ac-error{margin:10px 16px;padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px;word-break:break-word}
.ac-foot{padding:8px 16px;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-caption);font-size:11px;display:flex;gap:10px;align-items:center}
.ac-notice{color:var(--dsw-alias-state-success-primary)}
.ac-notice.bad{color:var(--dsw-alias-state-error-primary)}
`;
		//#endregion

		//#region 面板页面
		/**
		 * 产物中心面板：分类/后缀/关键字筛选、列表、复制路径、定位、删除。
		 * 筛选交给宿主 store.list（与 agent 工具同一条逻辑），面板只做展示。
		 */
		function ArtifactCenterPage(props) {
			const t = props && typeof props.t === "function" ? props.t : null;
			const tr = (key, vars) => {
				let text;
				try {
					text = t ? t(key) : undefined;
				} catch {
					text = undefined;
				}
				if (!text || text === key) text = zh[key] !== undefined ? zh[key] : key;
				if (vars) {
					for (const name of Object.keys(vars)) text = text.replace(`{${name}}`, String(vars[name]));
				}
				return text;
			};

			const [category, setCategory] = React.useState("");
			const [ext, setExt] = React.useState("");
			const [keyword, setKeyword] = React.useState("");
			const [nonce, setNonce] = React.useState(0);
			const [state, setState] = React.useState({ phase: "loading", data: null, error: "" });
			const [pendingDelete, setPendingDelete] = React.useState("");
			const [notice, setNotice] = React.useState(null);
			const noticeTimer = React.useRef(null);

			const flash = React.useCallback((text, bad) => {
				setNotice({ text, bad: Boolean(bad) });
				if (noticeTimer.current) clearTimeout(noticeTimer.current);
				noticeTimer.current = setTimeout(() => setNotice(null), 4000);
			}, []);

			React.useEffect(() => () => {
				if (noticeTimer.current) clearTimeout(noticeTimer.current);
			}, []);

			React.useEffect(() => {
				let alive = true;
				const query = new URLSearchParams();
				if (category) query.set("category", category);
				if (ext) query.set("ext", ext);
				if (keyword) query.set("keyword", keyword);
				const suffix = query.toString();
				const timer = setTimeout(async () => {
					try {
						const data = await api(`state${suffix ? `?${suffix}` : ""}`);
						if (alive) setState({ phase: "ready", data, error: "" });
					} catch (e) {
						if (alive) setState((prev) => ({ phase: "error", data: prev.data, error: e.message || String(e) }));
					}
				}, keyword ? 220 : 0);
				return () => {
					alive = false;
					clearTimeout(timer);
				};
			}, [category, ext, keyword, nonce]);

			const data = state.data;
			const items = data ? data.items : [];
			const stats = data ? data.stats : null;
			const byCategory = stats ? stats.byCategory || {} : {};
			const byExt = stats ? stats.byExt || {} : {};
			const categories = data && Array.isArray(data.categories) ? data.categories : Object.keys(CATEGORY_LABELS);
			const exts = Object.keys(byExt).sort((a, b) => byExt[b] - byExt[a] || a.localeCompare(b));
			const busy = state.phase === "loading";

			const copyPath = async (item) => {
				try {
					await navigator.clipboard.writeText(item.storedPath);
					flash(tr("copied"));
				} catch (e) {
					flash(`${tr("failed")}: ${e.message || e}`, true);
				}
			};

			const reveal = async (item) => {
				try {
					await api("reveal", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id: item.id }),
					});
				} catch (e) {
					flash(`${tr("failed")}: ${e.message || e}`, true);
				}
			};

			const remove = async (item) => {
				try {
					await api("remove", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id: item.id }),
					});
					setPendingDelete("");
					flash(`${tr("removed")}: ${item.title}`);
					setNonce((n) => n + 1);
				} catch (e) {
					flash(`${tr("failed")}: ${e.message || e}`, true);
				}
			};

			const row = (item) => h(
				"div",
				{ className: "ac-row", key: item.id },
				h("div", { className: "ac-cat" }, CATEGORY_LABELS[item.category] || item.category),
				h(
					"div",
					{ className: "ac-main" },
					h(
						"div",
						{ className: "ac-rowtitle", title: item.title },
						item.title,
						item.ext ? h("span", { className: "ac-ext" }, `.${item.ext}`) : null,
					),
					h("div", { className: "ac-path", title: item.storedPath }, item.storedPath),
					item.note ? h("div", { className: "ac-note" }, item.note) : null,
					h(
						"div",
						{ className: "ac-meta" },
						h("span", null, formatSize(item.size)),
						h("span", null, formatTime(item.createdAt)),
						h("span", null, item.mode === "link" ? tr("modeLink") : tr("modeCopy")),
						...(item.tags || []).map((tag) => h("span", { className: "ac-tag", key: tag }, tag)),
					),
				),
				h(
					"div",
					{ className: "ac-actions" },
					h("button", { className: "ac-btn", onClick: () => reveal(item) }, tr("reveal")),
					h("button", { className: "ac-btn", onClick: () => copyPath(item) }, tr("copyPath")),
					pendingDelete === item.id
						? h(
							"span",
							{ style: { display: "flex", gap: "5px" } },
							h("button", { className: "ac-btn danger", onClick: () => remove(item) }, tr("confirmRemove")),
							h("button", { className: "ac-btn", onClick: () => setPendingDelete("") }, tr("cancel")),
						)
						: h("button", { className: "ac-btn danger", onClick: () => setPendingDelete(item.id) }, tr("remove")),
				),
			);

			const chip = (label, active, count, onClick, key) => h(
				"button",
				{ className: "ac-chip", "data-on": active ? "1" : "0", onClick, key },
				label,
				count === undefined ? null : h("span", { className: "ac-count" }, String(count)),
			);

			return h(
				"div",
				{ className: "ac-page" },
				h("style", null, STYLE),
				h(
					"div",
					{ className: "ac-head" },
					h("div", { className: "ac-title" }, tr("title")),
					h(
						"div",
						{ className: "ac-sub" },
						data ? tr("count", { n: stats ? stats.total : items.length }) : "",
						data && data.rootDir ? ` · ${tr("rootDir")} ${data.rootDir}` : "",
					),
					h("button", { className: "ac-btn", onClick: () => setNonce((n) => n + 1), disabled: busy }, tr("refresh")),
				),
				h(
					"div",
					{ className: "ac-filters" },
					h(
						"div",
						{ className: "ac-chiprow" },
						h("span", { className: "ac-rowlabel" }, tr("catLabel")),
						chip(tr("all"), category === "", stats ? stats.total : undefined, () => setCategory(""), "__all"),
						...categories
							.filter((cat) => (byCategory[cat] || 0) > 0 || (cat === category && category !== ""))
							.map((cat) => chip(
								CATEGORY_LABELS[cat] || cat,
								category === cat,
								byCategory[cat] || 0,
								() => setCategory(category === cat ? "" : cat),
								cat,
							)),
					),
					exts.length === 0 && !ext ? null : h(
						"div",
						{ className: "ac-chiprow" },
						h("span", { className: "ac-rowlabel" }, tr("extLabel")),
						...exts.map((name) => chip(name, ext === name, byExt[name], () => setExt(ext === name ? "" : name), name)),
					),
					h("input", {
						className: "ac-search",
						placeholder: tr("search"),
						value: keyword,
						onChange: (event) => setKeyword(event.target.value),
					}),
				),
				state.error
					? h("div", { className: "ac-error" }, `${tr("loadError")}: ${state.error}`)
					: null,
				h(
					"div",
					{ className: "ac-body" },
					items.length > 0
						? items.map(row)
						: h(
							"div",
							{ className: "ac-empty" },
							h("div", null, data && data.stats && data.stats.total > 0 ? tr("noMatch") : tr("empty")),
							h("div", null, data && data.stats && data.stats.total > 0 ? "" : tr("emptyHint")),
						),
				),
				h(
					"div",
					{ className: "ac-foot" },
					notice ? h("span", { className: notice.bad ? "ac-notice bad" : "ac-notice" }, notice.text) : null,
					h("span", { style: { flex: 1 } }, notice ? "" : tr("hint")),
					busy ? h("span", null, "…") : null,
				),
			);
		}
		//#endregion

		//#region 插件外壳
		const inject = ["slots", "locale"];

		/**
		 * 贡献左侧栏面板行与其打开的 main 面板。
		 * @param ctx - 浏览器插件上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "artifact-center: dictionaries");
			const t = ctx.locale.bind(NS);

			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
			}, ArtifactCenterPage));

			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 30,
				locale: NS,
				label: () => t("panel"),
			}, ArtifactsPanelIcon));
		}
		//#endregion

		exports.NS = NS;
		exports.PANEL_ID = PANEL_ID;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
