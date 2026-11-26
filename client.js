/**
 * dsh-grokbot — Client half.
 *
 * A Grokbot-style multi-model group chat inside the DSH `main` slot:
 *   left   = room list
 *   center = append-only conversation + composer (task / chat mode)
 *   right  = members (each with its own provider/model) + task board
 *
 * Host API lives at /grokbot/api (see index.js). This client only polls it:
 *   GET  /bootstrap, GET /models
 *   POST /rooms, GET|DELETE /rooms/:id, GET /rooms/:id/export
 *   POST /rooms/:id/members, DELETE /rooms/:id/members/:mid
 *   POST /rooms/:id/messages, POST /rooms/:id/stop
 */

window.__ModuleLoader__.load({
	id: '@local/dsh-grokbot',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useState, useEffect, useRef, useCallback } = React;
		const NS = 'grokbot';
		const PKG = '@local/dsh-grokbot';
		const API = '/grokbot/api';

		const zh = { panel: '群聊协作' };
		const en = { panel: 'Group Chat' };

		const ROLE_LABEL = { captain: '总指挥', worker: '成员', reviewer: '质检' };
		const STATUS_LABEL = { pending: '排队', running: '执行中', done: '完成', failed: '失败', blocked: '阻塞' };
		const PHASE_LABEL = {
			plan: '规划中',
			work: '执行中',
			review: '质检中',
			synthesize: '汇总中',
			converge: '收敛中',
			chat: '讨论中',
			done: '已完成',
			stopped: '已停止',
			error: '失败',
		};
		const ROLE_ORDER = ['captain', 'worker', 'reviewer'];

		const CSS = `
.gb-root{position:relative;display:flex;height:100%;min-height:0;width:100%;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-family:var(--dsw-font-family,inherit);font-size:13px}
.gb-side{display:flex;flex-direction:column;width:212px;flex:0 0 212px;min-height:0;border-right:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02))}
.gb-side-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 12px 10px;font-weight:600}
.gb-rooms{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 8px 12px;display:flex;flex-direction:column;gap:2px}
.gb-room{display:flex;flex-direction:column;gap:3px;padding:9px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.gb-room:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.gb-room.active{background:var(--dsw-alias-bg-layer-2,#fff);border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.1));box-shadow:var(--dsw-elevation-panel,0 1px 2px rgba(0,0,0,.06))}
.gb-room-name{display:flex;align-items:center;gap:6px;font-weight:600;line-height:1.3;word-break:break-word}
.gb-room-preview{color:var(--dsw-alias-label-tertiary,#8a9099);font-size:12px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gb-room-meta{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-caption,#a2a8b0);font-size:11px}
.gb-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);flex:0 0 auto;animation:gb-pulse 1.4s ease-in-out infinite}
@keyframes gb-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.gb-main{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0}
.gb-main-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.gb-title{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gb-sub{color:var(--dsw-alias-label-tertiary,#8a9099);font-size:12px;white-space:nowrap}
.gb-head-actions{display:flex;align-items:center;gap:6px;margin-left:auto}
.gb-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;font:inherit;font-size:12px;padding:5px 10px;border-radius:7px;cursor:pointer;line-height:1.3;white-space:nowrap}
.gb-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.gb-btn:disabled{opacity:.45;cursor:not-allowed}
.gb-btn.primary{background:var(--dsw-alias-button-primary-fill,#2b6cf6);border-color:transparent;color:#fff;font-weight:600}
.gb-btn.primary:hover{background:var(--dsw-alias-button-primary-hover,#1f5be0)}
.gb-btn.danger{color:var(--dsw-alias-state-error-primary,#e5484d);border-color:var(--dsw-alias-state-error-primary,#e5484d)}
.gb-btn.ghost{border-color:transparent;background:transparent}
.gb-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;font-size:11px;line-height:18px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));color:var(--dsw-alias-label-secondary,#5b6169);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));white-space:nowrap}
.gb-chip.phase{color:var(--dsw-alias-state-business-primary,#2b6cf6);border-color:currentColor}
.gb-chip.captain{color:#8b5cf6;border-color:currentColor}
.gb-chip.reviewer{color:#d97706;border-color:currentColor}
.gb-chip.ok{color:var(--dsw-alias-state-success-primary,#16a34a);border-color:currentColor}
.gb-chip.bad{color:var(--dsw-alias-state-error-primary,#e5484d);border-color:currentColor}
.gb-messages{flex:1 1 auto;min-height:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.gb-msg{display:flex;gap:8px;max-width:100%}
.gb-msg.user{flex-direction:row-reverse}
.gb-avatar{width:26px;height:26px;flex:0 0 26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#fff;background:#64748b}
.gb-avatar.captain{background:#8b5cf6}
.gb-avatar.reviewer{background:#d97706}
.gb-msg-body{display:flex;flex-direction:column;gap:4px;min-width:0;max-width:min(760px,86%)}
.gb-msg.user .gb-msg-body{align-items:flex-end}
.gb-msg-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#8a9099);font-size:11px}
.gb-msg-name{color:var(--dsw-alias-label-secondary,#5b6169);font-weight:600;font-size:12px}
.gb-msg-text{padding:9px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f5f6f8);white-space:pre-wrap;word-break:break-word;line-height:1.55}
.gb-msg.user .gb-msg-text{background:var(--dsw-alias-button-primary-fill,#2b6cf6);color:#fff}
.gb-card{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);overflow:hidden}
.gb-card.plan{border-left:3px solid #8b5cf6}
.gb-card.review{border-left:3px solid #d97706}
.gb-card.summary{border-left:3px solid var(--dsw-alias-state-success-primary,#16a34a);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02))}
.gb-card-title{padding:8px 12px;font-weight:600;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));display:flex;align-items:center;gap:8px}
.gb-card-body{padding:10px 12px;white-space:pre-wrap;word-break:break-word;line-height:1.6}
.gb-sys{align-self:center;color:var(--dsw-alias-label-tertiary,#8a9099);font-size:12px;text-align:center;max-width:80%;line-height:1.5}
.gb-composer{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));padding:10px 14px 12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-base,#fff)}
.gb-modes{display:flex;align-items:center;gap:6px}
.gb-mode{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-label-secondary,#5b6169);font:inherit;font-size:12px;padding:3px 10px;border-radius:999px;cursor:pointer}
.gb-mode.active{background:var(--dsw-alias-label-primary,#1f2329);color:var(--dsw-alias-bg-base,#fff);border-color:transparent}
.gb-hint{color:var(--dsw-alias-label-caption,#a2a8b0);font-size:11px;margin-left:auto}
.gb-input{width:100%;box-sizing:border-box;resize:none;min-height:58px;max-height:180px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:10px;padding:9px 11px;font:inherit;font-size:13px;line-height:1.5;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));color:inherit;outline:none}
.gb-input:focus{border-color:var(--dsw-alias-state-business-primary,#2b6cf6)}
.gb-send-row{display:flex;align-items:center;gap:8px}
.gb-running{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#5b6169);font-size:12px}
.gb-aside{display:flex;flex-direction:column;width:330px;flex:0 0 330px;min-height:0;border-left:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02))}
.gb-aside-tabs{display:flex;gap:4px;padding:10px 10px 6px}
.gb-tab{flex:1 1 0;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary,#8a9099);font:inherit;font-size:12px;padding:5px 8px;border-radius:7px;cursor:pointer}
.gb-tab.active{background:var(--dsw-alias-bg-layer-2,#fff);border-color:var(--dsw-alias-border-l1,rgba(0,0,0,.1));color:var(--dsw-alias-label-primary,#1f2329);font-weight:600}
.gb-panel{flex:1 1 auto;min-height:0;overflow-y:auto;padding:6px 10px 14px;display:flex;flex-direction:column;gap:8px}
.gb-member{display:flex;align-items:flex-start;gap:8px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:9px;background:var(--dsw-alias-bg-base,#fff)}
.gb-member-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}
.gb-member-name{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12px}
.gb-member-model{color:var(--dsw-alias-label-tertiary,#8a9099);font-size:11px;word-break:break-all}
.gb-member-persona{color:var(--dsw-alias-label-secondary,#5b6169);font-size:11px;line-height:1.4;white-space:pre-wrap}
.gb-x{border:none;background:transparent;color:var(--dsw-alias-label-caption,#a2a8b0);cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;border-radius:5px}
.gb-x:hover{color:var(--dsw-alias-state-error-primary,#e5484d);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.gb-task{display:flex;flex-direction:column;gap:5px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:9px;background:var(--dsw-alias-bg-base,#fff)}
.gb-task-head{display:flex;align-items:flex-start;gap:6px;font-size:12px;font-weight:600;line-height:1.4}
.gb-task-head span{flex:1 1 auto;word-break:break-word}
.gb-status{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid currentColor;color:var(--dsw-alias-label-tertiary,#8a9099);white-space:nowrap}
.gb-status.running{color:var(--dsw-alias-state-business-primary,#2b6cf6)}
.gb-status.done{color:var(--dsw-alias-state-success-primary,#16a34a)}
.gb-status.failed{color:var(--dsw-alias-state-error-primary,#e5484d)}
.gb-status.blocked{color:var(--dsw-alias-state-warn-primary,#d97706)}
.gb-task-brief{color:var(--dsw-alias-label-secondary,#5b6169);font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.gb-task details{font-size:11px}
.gb-task summary{cursor:pointer;color:var(--dsw-alias-state-business-primary,#2b6cf6);font-size:11px}
.gb-task pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-word;font-family:var(--dsw-font-family,inherit);font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#5b6169);max-height:220px;overflow-y:auto}
.gb-field{display:flex;flex-direction:column;gap:4px}
.gb-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a9099)}
.gb-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.gb-select{flex:1 1 0;min-width:0;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:7px;padding:4px 6px;font:inherit;font-size:12px;background:var(--dsw-alias-bg-base,#fff);color:inherit;outline:none}
.gb-picker{display:flex;gap:6px;flex:1 1 auto;min-width:0}
.gb-note{color:var(--dsw-alias-label-tertiary,#8a9099);font-size:11px;line-height:1.4}
.gb-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-tertiary,#8a9099);text-align:center;padding:32px;line-height:1.6}
.gb-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-secondary,#5b6169)}
.gb-toast{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);background:#1f2329;color:#fff;padding:8px 14px;border-radius:8px;font-size:12px;z-index:60;max-width:70%;box-shadow:0 6px 24px rgba(0,0,0,.24)}
.gb-overlay{position:absolute;inset:0;background:rgba(15,18,22,.42);display:flex;align-items:center;justify-content:center;z-index:50;padding:24px}
.gb-dialog{width:min(560px,100%);max-height:88%;overflow-y:auto;background:var(--dsw-alias-bg-base,#fff);border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.28);padding:18px;display:flex;flex-direction:column;gap:12px}
.gb-dialog-title{font-size:14px;font-weight:700}
.gb-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.gb-seed{display:flex;align-items:center;gap:6px;padding:7px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px}
.gb-seed-name{width:88px;flex:0 0 88px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:6px;padding:3px 6px;font:inherit;font-size:12px;background:transparent;color:inherit;outline:none}
.gb-rule{height:1px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.08));margin:2px 0}
.gb-input.slim{padding:4px 6px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:6px;background:transparent;color:inherit;outline:none;min-width:0;flex:1 1 0}
.gb-link{border:none;background:transparent;color:var(--dsw-alias-state-business-primary,#2b6cf6);font:inherit;font-size:11px;padding:0;cursor:pointer;text-align:left}
.gb-search{margin:0 8px 6px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;font-size:12px;outline:none}
.gb-search:focus{border-color:var(--dsw-alias-state-business-primary,#2b6cf6)}
.gb-head-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap;justify-content:flex-end}
.gb-retry{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-state-business-primary,#2b6cf6);font:inherit;font-size:11px;padding:2px 8px;border-radius:6px;cursor:pointer}
.gb-retry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.gb-copy{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#8a9099);font:inherit;font-size:11px;cursor:pointer;padding:0 4px}
.gb-copy:hover{color:var(--dsw-alias-label-primary,#1f2329)}
@media (max-width: 1180px){.gb-aside{width:290px;flex-basis:290px}.gb-side{width:180px;flex-basis:180px}}
`;

		/* ---------------------------------------------------------------- util */

		async function request(path, options) {
			const init = options ? { ...options } : {};
			init.headers = { 'content-type': 'application/json', ...(init.headers ?? {}) };
			const res = await fetch(path, init);
			const text = await res.text();
			let data = null;
			try {
				data = text ? JSON.parse(text) : null;
			} catch {
				data = null;
			}
			if (!res.ok) {
				const message = data && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
				throw new Error(message);
			}
			return data;
		}

		function fmtTime(ts) {
			if (!ts) return '';
			const date = new Date(ts);
			const pad = (value) => String(value).padStart(2, '0');
			return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}

		function defaultMemberName(role) {
			if (role === 'captain') return '总指挥';
			if (role === 'reviewer') return '质检员';
			return '执行成员';
		}

		function runLabel(run) {
			if (!run) return '';
			if (run.status === 'running') return PHASE_LABEL[run.phase] ?? run.phase;
			if (run.status === 'stopped') return '已停止';
			if (run.status === 'error') return '失败';
			return '已完成';
		}

		/* ------------------------------------------------------------- pieces */

		function ModelPicker({ catalog, provider, model, onChange }) {
			const known = catalog.some((item) => item.provider === provider && item.models.some((entry) => entry.id === model));
			const [custom, setCustom] = useState(!known);
			const entry = catalog.find((item) => item.provider === provider) ?? catalog[0] ?? null;
			const models = entry ? entry.models : [];
			const changeProvider = (nextProvider) => {
				const nextModel = pickModel(catalog, nextProvider);
				rememberModel(nextProvider, nextModel);
				onChange(nextProvider, nextModel);
			};
			if (custom) {
				return h(
					'div',
					{ className: 'gb-field' },
					h(
						'div',
						{ className: 'gb-picker' },
						h('input', {
							className: 'gb-input slim',
							value: provider,
							placeholder: 'provider，如 openai-codex',
							onChange: (event) => onChange(event.target.value.trim(), model),
						}),
						h('input', {
							className: 'gb-input slim',
							value: model,
							placeholder: 'model，如 gpt-6.1-sol',
							onChange: (event) => {
								const nextModel = event.target.value.trim();
								rememberModel(provider, nextModel);
								onChange(provider, nextModel);
							},
						}),
					),
					h('button', { className: 'gb-link', type: 'button', onClick: () => setCustom(false) }, '← 从模型目录选择'),
				);
			}
			return h(
				'div',
				{ className: 'gb-field' },
				h(
					'div',
					{ className: 'gb-picker' },
					h(
						'select',
						{
							className: 'gb-select',
							value: entry ? entry.provider : '',
							onChange: (event) => changeProvider(event.target.value),
						},
						catalog.length === 0 ? h('option', { value: '' }, '无可用 provider') : null,
						catalog.map((item) => h('option', { key: item.provider, value: item.provider }, item.name || item.provider)),
					),
					h(
						'select',
						{
							className: 'gb-select',
							value: model,
							onChange: (event) => {
								const nextModel = event.target.value;
								const nextProvider = entry ? entry.provider : provider;
								rememberModel(nextProvider, nextModel);
								onChange(nextProvider, nextModel);
							},
						},
						models.map((item) => h('option', { key: item.id, value: item.id }, item.name || item.id)),
					),
				),
				h('button', { className: 'gb-link', type: 'button', onClick: () => setCustom(true) }, '自定义 provider / model（目录里没有也能填）'),
			);
		}

		async function copyText(text) {
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					await navigator.clipboard.writeText(text);
					return true;
				}
			} catch {
				// Clipboard permission may be denied; fall through to the manual hint.
			}
			return false;
		}

		function MessageView({ message }) {
			const [copied, setCopied] = useState(false);
			if (message.kind === 'system') {
				return h('div', { className: 'gb-sys' }, message.text);
			}
			if (message.kind === 'plan') {
				return h(
					'div',
					{ className: 'gb-card plan' },
					h('div', { className: 'gb-card-title' }, `${message.authorName || '总指挥'} · 任务拆分`),
					h('div', { className: 'gb-card-body' }, message.text),
				);
			}
			if (message.kind === 'review') {
				const verdict = message.meta && message.meta.verdict === 'pass' ? '通过' : '需修补';
				return h(
					'div',
					{ className: 'gb-card review' },
					h(
						'div',
						{ className: 'gb-card-title' },
						`${message.authorName || '质检'} · 质检结果`,
						h('span', { className: `gb-chip ${message.meta && message.meta.verdict === 'pass' ? 'ok' : 'bad'}` }, verdict),
					),
					h('div', { className: 'gb-card-body' }, message.text),
				);
			}
			if (message.kind === 'summary') {
				return h(
					'div',
					{ className: 'gb-card summary' },
					h(
						'div',
						{ className: 'gb-card-title' },
						`${message.authorName || '总指挥'} · 最终交付`,
						message.meta && message.meta.tokens ? h('span', { className: 'gb-chip' }, `${message.meta.tokens} tokens`) : null,
						h(
							'button',
							{
								className: 'gb-copy',
								title: '复制最终交付全文',
								onClick: () => {
									void copyText(message.text).then((ok) => {
										if (ok) setCopied(true);
									});
								},
							},
							copied ? '已复制' : '复制',
						),
					),
					h('div', { className: 'gb-card-body' }, message.text),
				);
			}
			const isUser = message.kind === 'user';
			return h(
				'div',
				{ className: `gb-msg ${isUser ? 'user' : 'member'}` },
				h('div', { className: `gb-avatar ${message.role || ''}` }, (message.authorName || '?').slice(0, 1)),
				h(
					'div',
					{ className: 'gb-msg-body' },
					h(
						'div',
						{ className: 'gb-msg-head' },
						h('span', { className: 'gb-msg-name' }, message.authorName || '成员'),
						!isUser && message.role ? h('span', { className: `gb-chip ${message.role}` }, ROLE_LABEL[message.role] || message.role) : null,
						message.meta && message.meta.model ? h('span', { className: 'gb-chip' }, message.meta.model) : null,
						message.meta && message.meta.taskTitle ? h('span', { className: 'gb-chip' }, message.meta.taskTitle) : null,
						h('span', null, fmtTime(message.ts)),
					),
					h('div', { className: 'gb-msg-text' }, message.text),
				),
			);
		}

		function MemberPanel({ room, catalog, onAdd, onUpdate, onRemove, locked }) {
			const [open, setOpen] = useState(false);
			const [name, setName] = useState('');
			const [role, setRole] = useState('worker');
			const [provider, setProvider] = useState(catalog[0] ? catalog[0].provider : '');
			const [model, setModel] = useState(catalog[0] ? pickModel(catalog, catalog[0].provider) : '');
			const [persona, setPersona] = useState('');
			const [error, setError] = useState('');
			const [saving, setSaving] = useState(false);
			const [editing, setEditing] = useState(null);
			const [editError, setEditError] = useState('');
			const [editSaving, setEditSaving] = useState(false);

			useEffect(() => {
				if (catalog.length === 0) return;
				if (!provider) setProvider(catalog[0].provider);
				if (!model) setModel(pickModel(catalog, provider || catalog[0].provider));
			}, [catalog, provider, model]);

			const saveEdit = async () => {
				if (!editing) return;
				setEditError('');
				setEditSaving(true);
				try {
					await onUpdate(editing.id, {
						name: editing.name.trim(),
						role: editing.role,
						provider: editing.provider,
						model: editing.model,
						persona: editing.persona.trim(),
					});
					setEditing(null);
				} catch (err) {
					setEditError(err.message);
				} finally {
					setEditSaving(false);
				}
			};

			const submit = async () => {
				setError('');
				if (!provider || !model) {
					setError('请选择 provider 与 model');
					return;
				}
				setSaving(true);
				try {
					await onAdd({ name: name.trim() || defaultMemberName(role), role, provider, model, persona: persona.trim() });
					setName('');
					setPersona('');
					setOpen(false);
				} catch (err) {
					setError(err.message);
				} finally {
					setSaving(false);
				}
			};

			return h(
				'div',
				{ className: 'gb-field' },
				room.members.length === 0
					? h('div', { className: 'gb-empty', style: { padding: '18px 6px' } }, h('div', { className: 'gb-empty-title' }, '还没有成员'), h('div', null, '至少添加一位总指挥。建议再加一位执行成员和一位质检员。'))
					: null,
				room.members.map((member) =>
					editing && editing.id === member.id
						? h(
								'div',
								{ key: member.id, className: 'gb-field', style: { border: '1px solid var(--dsw-alias-border-l1,#d9dce1)', borderRadius: 10, padding: '10px 12px' } },
								h('div', { className: 'gb-label' }, `调整「${member.name}」：模型 / 角色 / 名称`),
								h('input', { className: 'gb-input', style: { minHeight: 0, height: 30 }, value: editing.name, placeholder: '名称', onChange: (event) => setEditing({ ...editing, name: event.target.value }) }),
								h(
									'select',
									{ className: 'gb-select', value: editing.role, onChange: (event) => setEditing({ ...editing, role: event.target.value }) },
									ROLE_ORDER.map((item) => h('option', { key: item, value: item }, ROLE_LABEL[item])),
								),
								h(ModelPicker, { catalog, provider: editing.provider, model: editing.model, onChange: (nextProvider, nextModel) => setEditing({ ...editing, provider: nextProvider, model: nextModel }) }),
								h('input', { className: 'gb-input', style: { minHeight: 0, height: 30 }, value: editing.persona, placeholder: '专长 / 人设（可选）', onChange: (event) => setEditing({ ...editing, persona: event.target.value }) }),
								editError ? h('div', { className: 'gb-note', style: { color: 'var(--dsw-alias-state-error-primary,#e5484d)' } }, editError) : null,
								h(
									'div',
									{ className: 'gb-row', style: { justifyContent: 'flex-end' } },
									h('button', { className: 'gb-btn ghost', onClick: () => { setEditing(null); setEditError(''); } }, '取消'),
									h('button', { className: 'gb-btn primary', disabled: editSaving, onClick: saveEdit }, editSaving ? '保存中…' : '保存'),
								),
							)
						: h(
								'div',
								{ key: member.id, className: 'gb-member' },
								h('div', { className: `gb-avatar ${member.role}` }, member.name.slice(0, 1)),
								h(
									'div',
									{ className: 'gb-member-main' },
									h(
										'div',
										{ className: 'gb-member-name' },
										member.name,
										h('span', { className: `gb-chip ${member.role}` }, ROLE_LABEL[member.role] || member.role),
									),
									h('div', { className: 'gb-member-model' }, `${member.provider} / ${member.model}`),
									member.persona ? h('div', { className: 'gb-member-persona' }, member.persona) : null,
								),
								h(
									'span',
									{ style: { display: 'inline-flex', gap: 6 } },
									h(
										'button',
										{
											className: 'gb-x',
											title: '改模型 / 角色',
											disabled: locked,
											onClick: () => {
												setEditing({ id: member.id, name: member.name, role: member.role, provider: member.provider, model: member.model, persona: member.persona ?? '' });
												setEditError('');
											},
										},
										'改',
									),
									h('button', { className: 'gb-x', title: '移除成员', disabled: locked, onClick: () => onRemove(member.id) }, '×'),
								),
							),
				),
				h('div', { className: 'gb-rule' }),
				open
					? h(
							'div',
							{ className: 'gb-field' },
							h('div', { className: 'gb-label' }, '名称'),
							h('input', { className: 'gb-input', style: { minHeight: 0, height: 30 }, value: name, placeholder: defaultMemberName(role), onChange: (event) => setName(event.target.value) }),
							h('div', { className: 'gb-label' }, '角色'),
							h(
								'select',
								{ className: 'gb-select', value: role, onChange: (event) => setRole(event.target.value) },
								ROLE_ORDER.map((item) => h('option', { key: item, value: item }, ROLE_LABEL[item])),
							),
							h('div', { className: 'gb-label' }, '模型'),
							h(ModelPicker, { catalog, provider, model, onChange: (nextProvider, nextModel) => { setProvider(nextProvider); setModel(nextModel); } }),
							h('div', { className: 'gb-label' }, '专长 / 人设（可选）'),
							h('input', {
								className: 'gb-input',
								style: { minHeight: 0, height: 30 },
								value: persona,
								placeholder: '例：资深架构师，关注可维护性与边界条件',
								onChange: (event) => setPersona(event.target.value),
							}),
							error ? h('div', { className: 'gb-note', style: { color: 'var(--dsw-alias-state-error-primary,#e5484d)' } }, error) : null,
							h(
								'div',
								{ className: 'gb-row', style: { justifyContent: 'flex-end' } },
								h('button', { className: 'gb-btn ghost', onClick: () => setOpen(false) }, '取消'),
								h('button', { className: 'gb-btn primary', disabled: saving || locked, onClick: submit }, saving ? '加入中…' : '加入群聊'),
							),
						)
					: h('button', { className: 'gb-btn', disabled: locked, onClick: () => setOpen(true) }, '+ 添加成员'),
			);
		}

		function TaskPanel({ room, onRetry, locked }) {
			const runId = room.run ? room.run.id : null;
			const tasks = runId ? room.tasks.filter((task) => task.runId === runId) : room.tasks.slice(-8);
			const run = room.run;
			return h(
				'div',
				{ className: 'gb-field' },
				run
					? h(
							'div',
							{ className: 'gb-note' },
							`${run.mode === 'chat' ? '聊天' : '任务'} · ${runLabel(run)} · 模型调用 ${run.turns ?? 0} 次 · ${run.tokens ?? 0} tokens`,
						)
					: h('div', { className: 'gb-note' }, '还没有运行记录。发布任务后这里会出现任务板。'),
				tasks.length === 0 ? h('div', { className: 'gb-note' }, '本轮没有任务。') : null,
				tasks.map((task) =>
					h(
						'div',
						{ key: task.id, className: 'gb-task' },
						h(
							'div',
							{ className: 'gb-task-head' },
							h('span', null, task.title),
							h('span', { className: `gb-status ${task.status}` }, STATUS_LABEL[task.status] || task.status),
							task.status === 'failed' || task.status === 'blocked'
								? h(
										'button',
										{
											className: 'gb-retry',
											disabled: locked || !onRetry,
											onClick: () => onRetry && onRetry(task.id),
											title: '只重跑这一个任务，不重新规划整个群聊',
										},
										'重试',
									)
								: null,
						),
						h('div', { className: 'gb-note' }, `${task.assignee}${task.dependsOn && task.dependsOn.length ? ` · 依赖 ${task.dependsOn.length}` : ''} · 第 ${task.wave ?? 1} 轮`),
						h('div', { className: 'gb-task-brief' }, task.brief),
						task.error ? h('div', { className: 'gb-note', style: { color: 'var(--dsw-alias-state-error-primary,#e5484d)' } }, task.error) : null,
						task.result
							? h('details', null, h('summary', null, '查看产出'), h('pre', null, task.result))
							: null,
					),
				),
			);
		}

		const MODEL_MEMO_KEY = 'grokbot:model-memo';

		function readModelMemo() {
			try {
				const raw = window.localStorage.getItem(MODEL_MEMO_KEY);
				const parsed = raw ? JSON.parse(raw) : null;
				return parsed && typeof parsed === 'object' ? parsed : {};
			} catch {
				return {};
			}
		}

		function rememberModel(provider, model) {
			if (!provider || !model) return;
			try {
				const memo = readModelMemo();
				if (memo[provider] === model) return;
				memo[provider] = model;
				window.localStorage.setItem(MODEL_MEMO_KEY, JSON.stringify(memo));
			} catch {
				// localStorage may be unavailable; remembering is best-effort.
			}
		}

		function pickModel(catalog, provider) {
			const entry = catalog.find((item) => item.provider === provider);
			if (!entry || entry.models.length === 0) return '';
			const remembered = readModelMemo()[provider];
			return entry.models.some((item) => item.id === remembered) ? remembered : entry.models[0].id;
		}

		function firstFrom(catalog, providerIds) {
			for (const providerId of providerIds) {
				const entry = catalog.find((item) => item.provider === providerId && item.models.length > 0);
				if (entry) return { provider: entry.provider, model: pickModel(catalog, entry.provider) };
			}
			const fallback = catalog.find((item) => item.models.length > 0);
			return fallback ? { provider: fallback.provider, model: pickModel(catalog, fallback.provider) } : null;
		}

		function defaultSeeds(catalog) {
			const picks = [
				firstFrom(catalog, ['deepseek-official', 'moonshotai', 'openai-codex', 'antigravity']),
				firstFrom(catalog, ['openai-codex', 'moonshotai', 'antigravity', 'deepseek-official']),
				firstFrom(catalog, ['antigravity', 'openai-codex', 'moonshotai', 'deepseek-official']),
			];
			const roles = ['captain', 'worker', 'reviewer'];
			const names = ['总指挥', '执行成员', '质检员'];
			return roles.map((role, index) => {
				const pick = picks[index];
				return {
					enabled: Boolean(pick),
					role,
					name: names[index],
					provider: pick ? pick.provider : '',
					model: pick ? pick.model : '',
				};
			});
		}

		function NewRoomDialog({ catalog, onClose, onCreate }) {
			const [name, setName] = useState('');
			const [seeds, setSeeds] = useState(() => defaultSeeds(catalog));
			const [error, setError] = useState('');
			const [busy, setBusy] = useState(false);

			useEffect(() => {
				if (catalog.length === 0) return;
				setSeeds((prev) => (prev.some((seed) => seed.provider && seed.model) ? prev : defaultSeeds(catalog)));
			}, [catalog]);

			const update = (index, patch) => {
				setSeeds((prev) => prev.map((seed, cursor) => (cursor === index ? { ...seed, ...patch } : seed)));
			};

			const submit = async () => {
				setError('');
				const members = seeds
					.filter((seed) => seed.enabled && seed.provider && seed.model)
					.map((seed) => ({ name: seed.name.trim() || defaultMemberName(seed.role), role: seed.role, provider: seed.provider, model: seed.model }));
				setBusy(true);
				try {
					await onCreate(name.trim(), members);
				} catch (err) {
					setError(err.message);
					setBusy(false);
				}
			};

			return h(
				'div',
				{ className: 'gb-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
				h(
					'div',
					{ className: 'gb-dialog' },
					h('div', { className: 'gb-dialog-title' }, '新建多模型群聊'),
					h(
						'div',
						{ className: 'gb-field' },
						h('div', { className: 'gb-label' }, '群聊名称'),
						h('input', { className: 'gb-input', style: { minHeight: 0, height: 32 }, value: name, placeholder: '例：产品方案评审', onChange: (event) => setName(event.target.value) }),
					),
					h('div', { className: 'gb-label' }, '初始成员（每个成员各自独立调用自己的模型）'),
					seeds.map((seed, index) =>
						h(
							'div',
							{ key: seed.role, className: 'gb-seed' },
							h('input', { type: 'checkbox', checked: seed.enabled, onChange: (event) => update(index, { enabled: event.target.checked }) }),
							h(
								'select',
								{ className: 'gb-select', style: { flex: '0 0 88px', width: 88 }, value: seed.role, onChange: (event) => update(index, { role: event.target.value }) },
								ROLE_ORDER.map((role) => h('option', { key: role, value: role }, ROLE_LABEL[role])),
							),
							h('input', { className: 'gb-seed-name', value: seed.name, placeholder: '名称', onChange: (event) => update(index, { name: event.target.value }) }),
							h(ModelPicker, {
								catalog,
								provider: seed.provider,
								model: seed.model,
								onChange: (nextProvider, nextModel) => update(index, { provider: nextProvider, model: nextModel }),
							}),
						),
					),
					catalog.length === 0
						? h('div', { className: 'gb-note' }, '没有读取到可用的 provider/model，请先在 DSH 配置模型。也可以空群聊创建，稍后再添加成员。')
						: h('div', { className: 'gb-note' }, 'provider 名称对照：ChatGPT 订阅 = GPT-6.x / 5.6 系列（走订阅额度，不是按 token 账单，版本越新通常越吃额度）；Antigravity = Gemini 4 Hydrogen / Claude；Moonshot = Kimi。建议：总指挥负责拆分与收口，执行成员负责产出，质检员负责挑错。三者可以由同一个模型扮演，也可以各用一个模型。建好后成员行右侧「改」可随时换模型或换角色。'),
					error ? h('div', { className: 'gb-note', style: { color: 'var(--dsw-alias-state-error-primary,#e5484d)' } }, error) : null,
					h(
						'div',
						{ className: 'gb-dialog-actions' },
						h('button', { className: 'gb-btn ghost', onClick: onClose }, '取消'),
						h('button', { className: 'gb-btn primary', disabled: busy, onClick: submit }, busy ? '创建中…' : '创建群聊'),
					),
				),
			);
		}

		function PanelIcon() {
			return h(
				'span',
				{ style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'inherit' } },
				h(
					'svg',
					{ width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
					h('path', { d: 'M21 11.5a8.4 8.4 0 0 1-8.5 8.3 9 9 0 0 1-3.8-.8L3 21l1.9-4.6a8.1 8.1 0 0 1-1.4-4.6A8.4 8.4 0 0 1 12 3.5a8.4 8.4 0 0 1 9 8z' }),
					h('path', { d: 'M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01' }),
				),
			);
		}

		/* -------------------------------------------------------------- shell */

		function Shell({ ctx }) {
			const [rooms, setRooms] = useState([]);
			const [catalog, setCatalog] = useState([]);
			const [roomId, setRoomId] = useState(null);
			const [room, setRoom] = useState(null);
			const [messages, setMessages] = useState([]);
			const [draft, setDraft] = useState('');
			const [mode, setMode] = useState('task');
			const [tab, setTab] = useState('members');
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState('');
			const [showCreate, setShowCreate] = useState(false);
			const [confirmDelete, setConfirmDelete] = useState(false);
			const [search, setSearch] = useState('');
			const seqRef = useRef(0);
			const listRef = useRef(null);
			const toastTimer = useRef(null);

			const flash = useCallback((text) => {
				setNotice(text);
				window.clearTimeout(toastTimer.current);
				toastTimer.current = window.setTimeout(() => setNotice(''), 6000);
			}, []);

			const refreshRooms = useCallback(async () => {
				try {
					const data = await request(`${API}/bootstrap`);
					if (data && Array.isArray(data.rooms)) setRooms(data.rooms);
				} catch {
					// The host may still be mounting; the next poll retries.
				}
			}, []);

			useEffect(() => {
				void refreshRooms();
				const timer = window.setInterval(() => void refreshRooms(), 6000);
				return () => window.clearInterval(timer);
			}, [refreshRooms]);

			useEffect(() => {
				let alive = true;
				request(`${API}/models`)
					.then((data) => {
						if (alive && data && Array.isArray(data.providers)) setCatalog(data.providers);
					})
					.catch(() => {});
				return () => {
					alive = false;
				};
			}, []);

			useEffect(() => {
				if (!roomId) {
					setRoom(null);
					setMessages([]);
					return undefined;
				}
				let alive = true;
				seqRef.current = 0;
				setMessages([]);
				const tick = async () => {
					try {
						const data = await request(`${API}/rooms/${roomId}?since=${seqRef.current}`);
						if (!alive || !data) return;
						setRoom(data.room);
						if (Array.isArray(data.messages) && data.messages.length) {
							setMessages((prev) => {
								const known = new Set(prev.map((item) => item.seq));
								const merged = prev.concat(data.messages.filter((item) => !known.has(item.seq)));
								return merged.slice(-500);
							});
						}
						if (typeof data.lastSeq === 'number') seqRef.current = Math.max(seqRef.current, data.lastSeq);
					} catch {
						// transient errors while the app reloads; the interval retries
					}
				};
				void tick();
				const timer = window.setInterval(() => void tick(), 1600);
				return () => {
					alive = false;
					window.clearInterval(timer);
				};
			}, [roomId]);

			useEffect(() => {
				const element = listRef.current;
				if (!element) return;
				const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 200;
				if (nearBottom || messages.length <= 2) element.scrollTop = element.scrollHeight;
			}, [messages]);

			useEffect(() => {
				if (!confirmDelete) return undefined;
				const timer = window.setTimeout(() => setConfirmDelete(false), 4000);
				return () => window.clearTimeout(timer);
			}, [confirmDelete]);

			const running = Boolean(room && room.run && room.run.status === 'running');

			const createRoom = async (name, members) => {
				const data = await request(`${API}/rooms`, { method: 'POST', body: JSON.stringify({ name, members }) });
				if (data && Array.isArray(data.warnings) && data.warnings.length) flash(data.warnings.join('；'));
				setShowCreate(false);
				await refreshRooms();
				seqRef.current = 0;
				setRoomId(data.room.id);
			};

			const send = async () => {
				let text = draft.trim();
				let to = '';
				const mention = /^@([^\s：:]{1,40})[\s:：]+/.exec(text);
				if (mention) {
					to = mention[1];
					text = text.slice(mention[0].length).trim();
				}
				if (!text || !roomId || busy || running) return;
				if (!room || room.members.length === 0) {
					flash('请先在右侧添加成员');
					return;
				}
				if (to && mode !== 'chat') {
					flash('@ 定向发言只在群聊讨论里生效，任务模式会按任务板派给成员');
					to = '';
				}
				setBusy(true);
				try {
					const payload = { text, mode };
					if (to) payload.to = to;
					await request(`${API}/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify(payload) });
					setDraft('');
				} catch (error) {
					flash(error.message);
				} finally {
					setBusy(false);
				}
			};

			const retryTask = async (taskId) => {
				if (!roomId) return;
				try {
					await request(`${API}/rooms/${roomId}/tasks/${taskId}/retry`, { method: 'POST', body: '{}' });
					flash('已单独重跑这个任务');
				} catch (error) {
					flash(error.message);
				}
			};

			const reloadModels = async () => {
				try {
					const data = await request(`${API}/models?refresh=1`);
					if (data && Array.isArray(data.providers)) setCatalog(data.providers);
					flash('模型目录已刷新');
				} catch (error) {
					flash(error.message);
				}
			};

			const duplicateRoom = async () => {
				if (!roomId) return;
				try {
					const data = await request(`${API}/rooms/${roomId}/duplicate`, { method: 'POST', body: '{}' });
					await refreshRooms();
					seqRef.current = 0;
					setRoomId(data.room.id);
					flash('已复制出一份成员配置相同的群聊');
				} catch (error) {
					flash(error.message);
				}
			};

			const stop = async () => {
				if (!roomId) return;
				try {
					await request(`${API}/rooms/${roomId}/stop`, { method: 'POST', body: '{}' });
					flash('已请求停止');
				} catch (error) {
					flash(error.message);
				}
			};

			const addMember = async (payload) => {
				if (!roomId) throw new Error('请先选择群聊');
				await request(`${API}/rooms/${roomId}/members`, { method: 'POST', body: JSON.stringify(payload) });
			};

			const updateMember = async (memberId, patch) => {
				if (!roomId) throw new Error('请先选择群聊');
				const data = await request(`${API}/rooms/${roomId}/members/${memberId}`, {
					method: 'PUT',
					body: JSON.stringify(patch),
				});
				setRoom(data.room);
				void refreshRooms();
				flash('成员已更新');
			};

			const removeMember = async (memberId) => {
				if (!roomId) return;
				try {
					await request(`${API}/rooms/${roomId}/members/${memberId}`, { method: 'DELETE' });
				} catch (error) {
					flash(error.message);
				}
			};

			const deleteRoom = async () => {
				if (!roomId) return;
				if (!confirmDelete) {
					setConfirmDelete(true);
					return;
				}
				try {
					await request(`${API}/rooms/${roomId}`, { method: 'DELETE' });
					setConfirmDelete(false);
					setRoomId(null);
					await refreshRooms();
				} catch (error) {
					flash(error.message);
				}
			};

			const keyword = search.trim().toLowerCase();
			const shownRooms = keyword
				? rooms.filter((item) => `${item.name} ${item.preview || ''}`.toLowerCase().includes(keyword))
				: rooms;
			const roomList = shownRooms.map((item) =>
				h(
					'div',
					{
						key: item.id,
						className: `gb-room ${item.id === roomId ? 'active' : ''}`,
						onClick: () => {
							setConfirmDelete(false);
							setRoomId(item.id);
						},
					},
					h('div', { className: 'gb-room-name' }, item.running ? h('span', { className: 'gb-dot' }) : null, item.name),
					item.preview ? h('div', { className: 'gb-room-preview' }, item.preview) : null,
					h('div', { className: 'gb-room-meta' }, `${item.memberCount} 位成员`, h('span', null, '·'), fmtTime(item.updatedAt)),
				),
			);

			const header = room
				? h(
						'div',
						{ className: 'gb-main-head' },
						h('div', { style: { minWidth: 0 } }, h('div', { className: 'gb-title' }, room.name), h('div', { className: 'gb-sub' }, `${room.members.length} 位成员 · ${room.tasks.length} 个任务`)),
						room.run ? h('span', { className: 'gb-chip phase' }, runLabel(room.run)) : null,
						running ? h('span', { className: 'gb-chip' }, `第 ${(room.run.turns ?? 0) + 1} 次调用 · ${room.run.tokens ?? 0} tokens`) : null,
						h(
							'div',
							{ className: 'gb-head-actions' },
							running ? h('button', { className: 'gb-btn', onClick: stop }, '停止') : null,
							h('button', { className: 'gb-btn ghost', onClick: () => void reloadModels(), title: '重新读取 DSH 当前的模型目录' }, '刷新模型'),
							h('button', { className: 'gb-btn ghost', onClick: () => void duplicateRoom(), disabled: running, title: '复制一份成员配置相同的群聊' }, '复制'),
							h('a', { className: 'gb-btn', href: `${API}/rooms/${room.id}/export`, target: '_blank', rel: 'noreferrer', title: '导出 Markdown' }, '导出 MD'),
							h('a', { className: 'gb-btn', href: `${API}/rooms/${room.id}/export?format=json`, target: '_blank', rel: 'noreferrer', title: '导出完整 JSON（含任务板与运行记录）' }, 'JSON'),
							h('button', { className: `gb-btn ${confirmDelete ? 'danger' : 'ghost'}`, onClick: deleteRoom }, confirmDelete ? '确认删除' : '删除'),
						),
					)
				: null;

			const composer = room
				? h(
						'div',
						{ className: 'gb-composer' },
						h(
							'div',
							{ className: 'gb-modes' },
							h('button', { className: `gb-mode ${mode === 'task' ? 'active' : ''}`, onClick: () => setMode('task'), title: '总指挥拆任务 → 成员并行产出 → 质检 → 汇总' }, '任务协作'),
							h('button', { className: `gb-mode ${mode === 'chat' ? 'active' : ''}`, onClick: () => setMode('chat'), title: '各成员从自己的角色视角发言，总指挥收敛' }, '群聊讨论'),
							h('span', { className: 'gb-hint' }, running ? '协作进行中…' : 'Enter 发送 · Shift+Enter 换行 · @成员名 定向发言'),
						),
						h('textarea', {
							className: 'gb-input',
							value: draft,
							placeholder: mode === 'task' ? '发布一个任务，例如：为这个产品写一份上线方案，包含定位、定价与风险' : '抛一个话题，例如：这个架构的瓶颈在哪？',
							onChange: (event) => setDraft(event.target.value),
							onKeyDown: (event) => {
								if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
									event.preventDefault();
									void send();
								}
							},
						}),
						h(
							'div',
							{ className: 'gb-send-row' },
							h('span', { className: 'gb-note' }, mode === 'task' ? '任务会进入任务板，失败自动重试一次，质检不过会补一轮修补。' : '讨论不会产生任务板；开头写 @成员名 可以让这一位单独回答。'),
							h(
								'button',
								{ className: 'gb-btn primary', style: { marginLeft: 'auto' }, disabled: busy || running || !draft.trim(), onClick: () => void send() },
								busy ? '发送中…' : '发送',
							),
						),
					)
				: null;

			const center = room
				? h(
						'div',
						{ className: 'gb-main' },
						header,
						h(
							'div',
							{ className: 'gb-messages', ref: listRef },
							messages.length === 0 ? h('div', { className: 'gb-empty' }, h('div', { className: 'gb-empty-title' }, '加载中…')) : null,
							messages.map((message) => h(MessageView, { key: message.seq, message })),
						),
						composer,
					)
				: h(
						'div',
						{ className: 'gb-main' },
						h(
							'div',
							{ className: 'gb-empty' },
							h('div', { className: 'gb-empty-title' }, '选择一个群聊，或新建一个'),
							h('div', null, '每个群聊可以放 2-6 位成员，每位成员独立使用自己的 provider / model，不共享上下文，只通过任务与产物协作。'),
							h('button', { className: 'gb-btn primary', onClick: () => setShowCreate(true) }, '新建多模型群聊'),
						),
					);

			const aside = room
				? h(
						'div',
						{ className: 'gb-aside' },
						h(
							'div',
							{ className: 'gb-aside-tabs' },
							h('button', { className: `gb-tab ${tab === 'members' ? 'active' : ''}`, onClick: () => setTab('members') }, `成员 ${room.members.length}`),
							h('button', { className: `gb-tab ${tab === 'tasks' ? 'active' : ''}`, onClick: () => setTab('tasks') }, `任务板 ${room.tasks.filter((task) => room.run && task.runId === room.run.id).length}`),
						),
						h('div', { className: 'gb-panel' }, tab === 'members'
							? h(MemberPanel, { room, catalog, onAdd: addMember, onUpdate: updateMember, onRemove: removeMember, locked: running })
							: h(TaskPanel, { room, onRetry: retryTask, locked: running })),
					)
				: null;

			return h(
				'div',
				{ className: 'gb-root' },
				h(
					'div',
					{ className: 'gb-side' },
					h('div', { className: 'gb-side-head' }, h('span', null, '群聊协作'), h('button', { className: 'gb-btn', onClick: () => setShowCreate(true) }, '+ 新建')),
					h('input', {
						className: 'gb-search',
						value: search,
						placeholder: '搜索群聊…',
						onChange: (event) => setSearch(event.target.value),
					}),
					h('div', { className: 'gb-rooms' }, roomList),
				),
				center,
				aside,
				showCreate ? h(NewRoomDialog, { catalog, onClose: () => setShowCreate(false), onCreate: createRoom }) : null,
				notice ? h('div', { className: 'gb-toast' }, notice) : null,
			);
		}

		/* ---------------------------------------------------------------- apply */

		function apply(ctx) {
			ctx.effect(() => {
				const tag = document.createElement('style');
				tag.dataset.plugin = PKG;
				tag.textContent = CSS;
				document.head.append(tag);
				return () => tag.remove();
			}, `${PKG}: styles`);

			ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${PKG}: locale`);

			const t = (key, fallback) => {
				try {
					const value = ctx.locale.bind(NS)(key);
					if (typeof value === 'string' && value !== key) return value;
				} catch {
					// fall through to the literal
				}
				return fallback ?? key;
			};

			ctx.slots.inject('sidebar.panellist', () =>
				ctx.slots.register({ name: 'sidebar.panellist', id: 'grokbot', order: 27, label: () => t('panel', '群聊协作') }, PanelIcon),
			);

			ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'grokbot' }, () => h(Shell, { ctx })));
		}

		return { inject: ['slots', 'locale'], apply };
	},
});
