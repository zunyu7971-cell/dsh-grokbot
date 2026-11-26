/**
 * dsh-grokbot — Host half.
 *
 * A Grokbot-style multi-model group chat. A room is an append-only message log
 * plus a task board; every member owns its own provider/model and its own
 * context. The engine never shares conversation state between models: only
 * explicit artifacts (task briefs, dependency results, the final synthesis)
 * cross the boundary.
 *
 * Flow for a posted task:
 *   captain (role=captain) plans a small task DAG
 *   -> members execute ready tasks in parallel (write scope = its own answer)
 *   -> a reviewer (role=reviewer) checks the artifacts, optionally one repair wave
 *   -> the captain synthesizes one final deliverable back into the room.
 *
 * Chat mode skips planning: members answer from their own vantage point, then
 * the captain converges the discussion.
 *
 * Persistence: one JSON document per room under ~/.grokbot/rooms (override with
 * GROKBOT_DATA_DIR). Writes are atomic (tmp + rename), so a crash cannot leave
 * a half-written room file.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const name = 'grokbot';
export const inject = ['webServer', 'llm'];

const DATA_DIR = process.env.GROKBOT_DATA_DIR || join(homedir(), '.grokbot');
const ROOMS_DIR = join(DATA_DIR, 'rooms');
const API_PREFIX = '/grokbot/api';

const MAX_TURNS_PER_RUN = 18;
const MAX_PARALLEL = 3;
const MAX_WAVES = 2;
const MAX_TOKENS = 2000;
const SYNTH_TOKENS = 3000;
const CHAT_TOKENS = 800;
const HISTORY_LIMIT = 8;
const CONTEXT_CHARS = 1400;
const CATALOG_TTL_MS = 120_000;
const PROVIDER_LABEL = {
	'deepseek-official': 'DeepSeek',
	'deepseek-vision': 'DeepSeek + 自动识图',
	moonshotai: 'Moonshot（Kimi）',
	'moonshotai-vision': 'Moonshot + 自动识图',
	antigravity: 'Antigravity（Gemini 4 / Claude）',
	'antigravity-vision': 'Antigravity + 自动识图',
	'openai-codex': 'ChatGPT 订阅（GPT-6.x）',
	'openai-codex-vision': 'ChatGPT 订阅 + 自动识图',
};
const ROLE_LABEL = { captain: '总指挥', worker: '执行成员', reviewer: '质检员' };
const ROLES = new Set(Object.keys(ROLE_LABEL));

const VERSION = '1.1.0';
const MAX_ROOMS = 200;
const MAX_ROOM_NAME = 60;
const MAX_MEMBER_NAME = 40;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_MEMBERS = 6;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function now() {
	return Date.now();
}

function makeId(prefix) {
	return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function truncate(text, max) {
	const value = typeof text === 'string' ? text : String(text ?? '');
	return value.length > max ? `${value.slice(0, max)}\n…（已截断）` : value;
}

function ensureDirs() {
	if (!existsSync(ROOMS_DIR)) mkdirSync(ROOMS_DIR, { recursive: true });
}

function roomPath(id) {
	// Room ids are generated server-side, but a hand-edited room file must never
	// be able to point at a path outside the rooms directory.
	if (!ROOM_ID_PATTERN.test(String(id))) throw new Error(`非法群聊 id：${String(id)}`);
	return join(ROOMS_DIR, `${id}.json`);
}

function saveRoom(room) {
	// A deleted room keeps running workflows in memory for a moment; they must
	// not resurrect the JSON file after the user deleted the room.
	if (room.deleted) return;
	ensureDirs();
	const target = roomPath(room.id);
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(room, null, 2), 'utf8');
	renameSync(tmp, target);
}

function loadRooms(rooms) {
	ensureDirs();
	let names = [];
	try {
		names = readdirSync(ROOMS_DIR).filter((file) => file.endsWith('.json'));
	} catch {
		return;
	}
	for (const file of names) {
		try {
			const parsed = JSON.parse(readFileSync(join(ROOMS_DIR, file), 'utf8'));
			if (parsed && typeof parsed.id === 'string' && ROOM_ID_PATTERN.test(parsed.id)) {
				parsed.messages = Array.isArray(parsed.messages) ? parsed.messages : [];
				parsed.tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
				parsed.runs = Array.isArray(parsed.runs) ? parsed.runs : [];
				parsed.members = Array.isArray(parsed.members) ? parsed.members : [];
				parsed.seq = Number.isFinite(parsed.seq) ? parsed.seq : parsed.messages.length;
				parsed.deleted = false;
				// A run that was still "running" when the host died would lock the
				// room forever (isRunning stays true). Recover it as interrupted.
				for (const run of parsed.runs) {
					if (run && run.status === 'running') {
						run.status = 'interrupted';
						run.phase = 'interrupted';
						run.endedAt = run.endedAt ?? Date.now();
						run.error = '宿主重启，这一轮已中断，可以重新发布任务';
					}
				}
				rooms.set(parsed.id, parsed);
			}
		} catch {
			// A corrupt room file must not take the whole plugin down.
		}
	}
}

function appendMessage(room, partial) {
	if (room.deleted) return null;
	const message = {
		seq: (room.seq ?? 0) + 1,
		ts: now(),
		kind: partial.kind,
		authorId: partial.authorId ?? null,
		authorName: partial.authorName ?? null,
		role: partial.role ?? null,
		taskId: partial.taskId ?? null,
		runId: partial.runId ?? null,
		text: typeof partial.text === 'string' ? partial.text : String(partial.text ?? ''),
		meta: partial.meta ?? null,
	};
	room.seq = message.seq;
	room.messages.push(message);
	room.updatedAt = message.ts;
	saveRoom(room);
	return message;
}

function safeDecode(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

/**
 * Same-origin guard for the local HTTP API.
 *
 * The API is reachable from any page the user's browser has open, so a wildcard
 * CORS policy would let a random website create rooms and spend the user's
 * model credits. Browsers attach an Origin header to every cross-site write, so
 * reject any Origin that is not this server's own origin (or another loopback
 * origin, which covers the desktop shell's local host).
 */
function originAllowed(req) {
	const origin = req.headers?.origin;
	if (typeof origin !== 'string' || origin === '') return true; // curl / local tooling
	if (origin === 'null') return false; // sandboxed iframe or file:// page
	let parsed;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
	const host = String(req.headers?.host ?? '').toLowerCase();
	if (host !== '' && parsed.host.toLowerCase() === host) return true;
	const port = String(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'));
	const hostPort = host.includes(':') ? host.slice(host.lastIndexOf(':') + 1) : '';
	return LOOPBACK_HOSTS.has(parsed.hostname) && (hostPort === '' || hostPort === port);
}

function currentRun(room) {
	for (let i = room.runs.length - 1; i >= 0; i -= 1) {
		if (room.runs[i].status === 'running') return room.runs[i];
	}
	return room.runs.length ? room.runs[room.runs.length - 1] : null;
}

function pickCaptain(room) {
	return room.members.find((member) => member.role === 'captain') ?? room.members[0] ?? null;
}

function memberByName(room, name) {
	const key = String(name ?? '').trim().toLowerCase();
	if (key === '') return null;
	return (
		room.members.find((member) => member.name.trim().toLowerCase() === key) ??
		room.members.find((member) => member.name.trim().toLowerCase().includes(key)) ??
		room.members.find((member) => key.includes(member.name.trim().toLowerCase())) ??
		null
	);
}

function taskStatus(room, id) {
	return room.tasks.find((task) => task.id === id)?.status ?? 'missing';
}

function publicRoom(room) {
	return {
		id: room.id,
		name: room.name,
		createdAt: room.createdAt,
		updatedAt: room.updatedAt,
		seq: room.seq,
		members: room.members,
		tasks: room.tasks.slice(-40),
		run: currentRun(room),
	};
}

function roomSummary(room) {
	const last = room.messages[room.messages.length - 1];
	return {
		id: room.id,
		name: room.name,
		updatedAt: room.updatedAt,
		createdAt: room.createdAt,
		memberCount: room.members.length,
		running: room.runs.some((run) => run.status === 'running'),
		preview: last ? truncate(last.text.replace(/\s+/g, ' '), 80) : '',
	};
}

/* ------------------------------------------------------------------ prompts */

function rosterLine(room) {
	return room.members
		.map((member) => `- ${member.name}｜${ROLE_LABEL[member.role] ?? member.role}｜${member.provider}/${member.model}${member.persona ? `｜${member.persona}` : ''}`)
		.join('\n');
}

function planSystem(room) {
	return `你是多模型协作群聊「${room.name}」的总指挥（Captain）。你的职责是把用户任务拆成 2-5 个自包含的子任务，指派给最合适的成员，让团队一次就把活干完。
规则：
- 每个子任务必须有明确交付物和判断标准，能被一个成员独立完成；
- 能并行的不要串行；有前后依赖的用 dependsOn 按标题引用；
- assignee 必须使用下面列出的成员名字之一；
- 你不要自己执行任务，只做拆分和验收设计。
只输出 JSON，不要解释，不要代码围栏。`;
}

function planUser(room, text) {
	return `## 可用成员
${rosterLine(room)}

## 用户任务
${text}

## 输出 JSON 格式
{"analysis":"一句话判断任务难度与拆分思路","tasks":[{"title":"简短标题","brief":"给该成员的完整指令：交付什么、做到什么标准、注意什么","assignee":"成员名字","dependsOn":[]}]}`;
}

function workerSystem(room, member) {
	return `你是多模型协作群聊「${room.name}」的成员「${member.name}」，角色是${ROLE_LABEL[member.role] ?? member.role}。${member.persona ? `\n你的专长：${member.persona}` : ''}
你只负责被指派的那个子任务。直接产出可交付的成果：结论、方案、结构、数字、代码或检查清单；不要复述背景，不要讨论协作流程，不要写“作为 AI”。使用中文，控制在 ${MAX_TOKENS} tokens 内。`;
}

function workerUser(room, task, rootText) {
	const deps = task.dependsOn
		.map((id) => room.tasks.find((item) => item.id === id))
		.filter((item) => item && item.status === 'done' && item.result);
	const siblings = room.tasks.filter((item) => item.runId === task.runId && item.id !== task.id && item.status !== 'done');
	const parts = [`## 群聊任务\n${rootText}`, `## 你的子任务：${task.title}\n${task.brief}`];
	if (deps.length) {
		parts.push(
			`## 依赖任务已完成，可直接引用其结论\n${deps
				.map((item) => `### ${item.title}（${item.assignee}）\n${truncate(item.result, CONTEXT_CHARS)}`)
				.join('\n\n')}`,
		);
	}
	parts.push(`## 并行中的其他成员（避免重复他们的职责）\n${siblings.map((item) => `- ${item.title} → ${item.assignee}`).join('\n') || '（无）'}`);
	parts.push('现在给出你的交付。');
	return parts.join('\n\n');
}

function reviewSystem(room) {
	return `你是多模型协作群聊「${room.name}」的质检员。你只做质检：判断团队产出是否真的完成任务、是否自相矛盾、是否遗漏关键事实或可执行细节。只输出 JSON，不要代码围栏。`;
}

function reviewUser(room, text, tasks) {
	const artifacts = tasks
		.map(
			(task, index) =>
				`### ${index + 1}. ${task.title}（${task.assignee}）\n${task.result ? truncate(task.result, 2000) : `（无产出，任务状态：${task.status}）`}`,
		)
		.join('\n\n');
	return `## 用户任务
${text}

## 团队产出
${artifacts}

## 输出 JSON
{"verdict":"pass 或 revise","notes":"结论与主要问题（pass 也写一句）","fixes":[{"title":"修补任务标题","brief":"最小修补指令","assignee":"成员名字"}]}
判定标准：能直接交付、覆盖任务要求、无明显事实或逻辑错误 → pass；否则 revise，并给出最多 3 个最小修补任务（按标题引用现有产出，不要求重做全部工作）。`;
}

function synthSystem(room) {
	return `你是多模型协作群聊「${room.name}」的总指挥。现在把所有成员的成果合成一份最终交付。
要求：
- 直接给用户能用的结果：结论先行、结构清晰、保留关键数字与取舍理由；
- 合并重复内容、消解矛盾、明确指出仍不确定的地方；
- 不要复述“谁说了什么”，不要描述协作流程；
- Markdown 输出，中文。`;
}

function synthUser(room, text, review, runId) {
	const artifacts = room.tasks
		.filter((task) => task.runId === runId)
		.slice(-6)
		.map((task) => `### ${task.title}（${task.assignee}）\n${task.result ? truncate(task.result, 2200) : '（失败，无产出）'}`)
		.join('\n\n');
	const feedback = review ? `判定：${review.verdict}；备注：${review.notes}` : '（没有质检员，按你的判断收敛）';
	return `## 用户任务
${text}

## 团队产出
${artifacts}

## 质检意见
${feedback}

现在输出最终交付。`;
}

function chatSystem(room, member) {
	return `你是群聊「${room.name}」的成员「${member.name}」（${ROLE_LABEL[member.role] ?? member.role}）。${member.persona ? `\n你的专长：${member.persona}` : ''}
现在大家在讨论同一个问题。只代表你的角色视角简短发言（不超过 220 字）：给出判断、补充关键事实或指出漏洞；不要客套、不要复述别人原话、不要写“作为 AI”。中文。`;
}

function directSystem(room, member) {
	return `你是群聊「${room.name}」的成员「${member.name}」（${ROLE_LABEL[member.role] ?? member.role}）。${member.persona ? `\n你的专长：${member.persona}` : ''}
用户点名问你，请完整回答这个问题（不超过 600 字）：结论先行，给出依据、关键数字或可执行步骤；不要提到其他成员，不要客套，不要写“作为 AI”。中文。`;
}

function chatUser(room, text) {
	const history = room.messages
		.filter((message) => message.kind === 'user' || message.kind === 'member' || message.kind === 'summary')
		.slice(-HISTORY_LIMIT)
		.map((message) => `[${message.authorName ?? '用户'}] ${truncate(message.text, 700)}`)
		.join('\n\n');
	return `## 最近对话\n${history || '（还没有历史）'}\n\n## 用户最新发言\n${text}\n\n给出你的发言。`;
}

function converSystem(room) {
	return `你是群聊「${room.name}」的总指挥。把刚才的讨论收敛成一段结论：已形成的共识、关键分歧、下一步建议，不超过 400 字。不要复述每个人的原话，不要罗列发言人。中文。`;
}

function converUser(room, text) {
	const history = room.messages
		.filter((message) => message.kind === 'user' || message.kind === 'member')
		.slice(-HISTORY_LIMIT)
		.map((message) => `[${message.authorName ?? '用户'}] ${truncate(message.text, 700)}`)
		.join('\n\n');
	return `## 讨论内容\n${history}\n\n## 用户的最新问题\n${text}\n\n输出收敛结论。`;
}

function parseJsonLoose(text) {
	if (typeof text !== 'string' || text.trim() === '') return null;
	let source = text.trim();
	const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) source = fence[1].trim();
	const start = source.indexOf('{');
	const end = source.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	source = source.slice(start, end + 1);
	const attempts = [source, source.replace(/,\s*([}\]])/g, '$1')];
	for (const attempt of attempts) {
		try {
			return JSON.parse(attempt);
		} catch {
			// try the next normalization
		}
	}
	return null;
}

/* ------------------------------------------------------------------- engine */

class Grokbot {
	constructor(ctx) {
		this.ctx = ctx;
		this.rooms = new Map();
		this.active = new Map();
		this.catalogCache = { at: 0, providers: [] };
		loadRooms(this.rooms);
	}

	/* ---- http ---- */

	async handle(req, res) {
		try {
			await this.route(req, res);
		} catch (error) {
			const status = Number.isInteger(error?.status) ? error.status : 500;
			this.sendJson(res, status, { error: error?.message ?? String(error) });
		}
	}

	sendJson(res, status, payload) {
		if (res.headersSent) return;
		const body = payload === null ? '' : JSON.stringify(payload);
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
		});
		res.end(body);
	}

	async route(req, res) {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const path = url.pathname.replace(/\/+$/, '');
		const method = (req.method ?? 'GET').toUpperCase();

		if (!originAllowed(req)) {
			this.sendJson(res, 403, { error: '跨站请求被拒绝：本插件只接受本机同源请求' });
			return;
		}
		if (method === 'OPTIONS') {
			res.writeHead(204, {
				'access-control-allow-origin': req.headers.origin ?? '',
				'access-control-allow-headers': 'content-type',
				'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
				'access-control-max-age': '600',
				vary: 'origin',
			});
			res.end();
			return;
		}
		if (path === `${API_PREFIX}/health`) {
			this.sendJson(res, 200, { ok: true, version: VERSION, dataDir: DATA_DIR, rooms: this.rooms.size });
			return;
		}
		if (path === `${API_PREFIX}/models` && method === 'GET') {
			if (url.searchParams.get('refresh') === '1') this.catalogCache = { at: 0, providers: [] };
			this.sendJson(res, 200, { providers: await this.catalog() });
			return;
		}
		if (path === `${API_PREFIX}/bootstrap` && method === 'GET') {
			const rooms = [...this.rooms.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).map(roomSummary);
			this.sendJson(res, 200, { rooms });
			return;
		}
		if (path === `${API_PREFIX}/rooms` && method === 'POST') {
			const body = await this.readJson(req);
			const created = this.createRoom(body);
			this.sendJson(res, 200, { room: publicRoom(created.room), warnings: created.warnings });
			return;
		}

		const match = path.match(
			/^\/grokbot\/api\/rooms\/([^/]+)(?:\/(members|messages|stop|export|tasks|duplicate))?(?:\/([^/]+))?(?:\/(retry))?$/,
		);
		if (!match) {
			this.sendJson(res, 404, { error: 'not found' });
			return;
		}
		const roomId = safeDecode(match[1]);
		const action = match[2];
		const sub = match[3] ? safeDecode(match[3]) : null;
		if (roomId === null || (match[3] && sub === null)) {
			this.sendJson(res, 400, { error: '群聊或成员 id 编码不合法' });
			return;
		}
		const room = this.mustRoom(roomId);
		if (action === 'duplicate' && method === 'POST') {
			const copy = this.duplicateRoom(room);
			this.sendJson(res, 200, { room: publicRoom(copy) });
			return;
		}
		if (action === 'tasks' && method === 'POST' && sub && match[4] === 'retry') {
			const result = this.retryTask(room, sub);
			this.sendJson(res, 200, result);
			return;
		}

		if (!action && method === 'GET') {
			const since = Number(url.searchParams.get('since') ?? 0) || 0;
			this.sendJson(res, 200, {
				room: publicRoom(room),
				messages: room.messages.filter((message) => message.seq > since),
				lastSeq: room.seq,
			});
			return;
		}
		if (!action && method === 'DELETE') {
			this.deleteRoom(room);
			this.sendJson(res, 200, { ok: true });
			return;
		}
		if (action === 'members' && method === 'POST') {
			const body = await this.readJson(req);
			const member = this.addMember(room, body);
			this.sendJson(res, 200, { member, room: publicRoom(room) });
			return;
		}
		if (action === 'members' && method === 'DELETE' && sub) {
			this.removeMember(room, sub);
			this.sendJson(res, 200, { room: publicRoom(room) });
			return;
		}
		if (action === 'members' && method === 'PUT' && sub) {
			const body = await this.readJson(req);
			const member = this.updateMember(room, sub, body);
			this.sendJson(res, 200, { member, room: publicRoom(room) });
			return;
		}
		if (action === 'messages' && method === 'POST') {
			const body = await this.readJson(req);
			const result = this.postMessage(room, body);
			this.sendJson(res, 200, result);
			return;
		}
		if (action === 'stop' && method === 'POST') {
			this.stopRun(room);
			this.sendJson(res, 200, { ok: true });
			return;
		}
		if (action === 'export' && method === 'GET') {
			const safeName = encodeURIComponent(room.name || room.id);
			if (url.searchParams.get('format') === 'json') {
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'content-disposition': `attachment; filename="${safeName}.json"`,
				});
				res.end(JSON.stringify(room, null, 2));
				return;
			}
			const markdown = this.exportRoom(room);
			res.writeHead(200, {
				'content-type': 'text/markdown; charset=utf-8',
				'content-disposition': `attachment; filename="${safeName}.md"`,
			});
			res.end(markdown);
			return;
		}
		this.sendJson(res, 404, { error: 'not found' });
	}

	readJson(req) {
		return new Promise((resolve, reject) => {
			let body = '';
			req.on('data', (chunk) => {
				body += chunk;
				if (body.length > 2_000_000) {
					reject(Object.assign(new Error('请求体过大'), { status: 413 }));
					req.destroy();
				}
			});
			req.on('end', () => {
				if (body.trim() === '') return resolve({});
				try {
					resolve(JSON.parse(body));
				} catch {
					reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
				}
			});
			req.on('error', reject);
		});
	}

	mustRoom(id) {
		const room = this.rooms.get(id);
		if (!room) throw Object.assign(new Error(`群聊 ${id} 不存在`), { status: 404 });
		return room;
	}

	/* ---- catalog ---- */

	async catalog() {
		if (Date.now() - this.catalogCache.at < CATALOG_TTL_MS && this.catalogCache.providers.length) {
			return this.catalogCache.providers;
		}
		const providers = this.ctx.llm.listProviders();
		const result = await Promise.all(
			providers.map(async (provider) => {
				try {
					const models = await this.ctx.llm.listModels(provider.id);
					return {
						provider: provider.id,
						name: PROVIDER_LABEL[provider.id] ?? provider.name ?? provider.id,
						models: (models ?? []).map((model) => ({ id: model.id, name: model.name ?? model.id })),
					};
				} catch (error) {
					return { provider: provider.id, name: PROVIDER_LABEL[provider.id] ?? provider.name ?? provider.id, models: [], error: String(error?.message ?? error) };
				}
			}),
		);
		const usable = result.filter((entry) => entry.models.length > 0);
		this.catalogCache = { at: Date.now(), providers: usable };
		return usable;
	}

	/* ---- rooms ---- */

	normalizeMember(input, room) {
		const memberName = String(input?.name ?? '').trim();
		if (memberName === '') throw Object.assign(new Error('成员名称不能为空'), { status: 400 });
		if (memberName.length > MAX_MEMBER_NAME) {
			throw Object.assign(new Error(`成员名称最长 ${MAX_MEMBER_NAME} 个字符`), { status: 400 });
		}
		if (room.members.some((member) => member.name.toLowerCase() === memberName.toLowerCase())) {
			throw Object.assign(new Error(`成员名称「${memberName}」已存在`), { status: 400 });
		}
		const provider = String(input?.provider ?? '').trim();
		const model = String(input?.model ?? '').trim();
		if (provider === '' || model === '') throw Object.assign(new Error('成员必须指定 provider 和 model'), { status: 400 });
		const role = ROLES.has(input?.role) ? input.role : 'worker';
		return {
			id: makeId('m'),
			name: memberName,
			provider,
			model,
			role,
			persona: String(input?.persona ?? '').trim(),
			addedAt: now(),
		};
	}

	createRoom(body) {
		if (this.rooms.size >= MAX_ROOMS) {
			throw Object.assign(new Error(`群聊数量已达上限（${MAX_ROOMS}），请先删除不用的群聊`), { status: 400 });
		}
		const roomName =
			String(body?.name ?? '')
				.trim()
				.slice(0, MAX_ROOM_NAME) || `群聊 ${new Date().toLocaleString('zh-CN')}`;
		const room = {
			id: makeId('r'),
			name: roomName,
			createdAt: now(),
			updatedAt: now(),
			seq: 0,
			members: [],
			messages: [],
			tasks: [],
			runs: [],
		};
		const members = Array.isArray(body?.members) ? body.members : [];
		const warnings = [];
		for (const candidate of members) {
			if (room.members.length >= MAX_MEMBERS) {
				warnings.push(`成员数超过上限（${MAX_MEMBERS}），多余的种子成员已忽略`);
				break;
			}
			try {
				room.members.push(this.normalizeMember(candidate, room));
			} catch (error) {
				// A bad seed must not silently vanish: report it to the caller.
				warnings.push(`种子成员「${String(candidate?.name ?? '未命名')}」未添加：${error?.message ?? error}`);
			}
		}
		if (room.members.length && !room.members.some((member) => member.role === 'captain')) {
			room.members[0].role = 'captain';
		}
		this.rooms.set(room.id, room);
		appendMessage(room, {
			kind: 'system',
			text: room.members.length
				? `群聊已创建，成员 ${room.members.length} 位。发布任务后总指挥会自动拆解并组织协作。`
				: '群聊已创建。先在右侧添加成员（建议至少一位总指挥、一位执行成员、一位质检员）。',
		});
		saveRoom(room);
		return { room, warnings };
	}

	addMember(room, body) {
		if (room.members.length >= MAX_MEMBERS) throw Object.assign(new Error(`一个群聊最多 ${MAX_MEMBERS} 位成员`), { status: 400 });
		const member = this.normalizeMember(body, room);
		if (!room.members.some((existing) => existing.role === 'captain')) member.role = 'captain';
		room.members.push(member);
		appendMessage(room, {
			kind: 'system',
			text: `成员「${member.name}」加入群聊（${ROLE_LABEL[member.role]}，${member.provider}/${member.model}）。`,
		});
		saveRoom(room);
		return member;
	}

	removeMember(room, memberId) {
		const index = room.members.findIndex((member) => member.id === memberId);
		if (index < 0) throw Object.assign(new Error('成员不存在'), { status: 404 });
		if (this.isRunning(room)) throw Object.assign(new Error('协作运行中不能调整成员，请先停止'), { status: 409 });
		const [member] = room.members.splice(index, 1);
		if (member.role === 'captain' && room.members.length && !room.members.some((item) => item.role === 'captain')) {
			room.members[0].role = 'captain';
		}
		appendMessage(room, { kind: 'system', text: `成员「${member.name}」已离开群聊。` });
		saveRoom(room);
	}

	updateMember(room, memberId, body) {
		const member = room.members.find((item) => item.id === memberId);
		if (!member) throw Object.assign(new Error('成员不存在'), { status: 404 });
		if (this.isRunning(room)) throw Object.assign(new Error('协作运行中不能调整成员，请先停止'), { status: 409 });
		const nextName = body?.name === undefined ? member.name : String(body.name ?? '').trim();
		if (nextName === '') throw Object.assign(new Error('成员名称不能为空'), { status: 400 });
		if (room.members.some((item) => item.id !== member.id && item.name.toLowerCase() === nextName.toLowerCase())) {
			throw Object.assign(new Error(`成员名称「${nextName}」已存在`), { status: 400 });
		}
		const nextProvider = body?.provider === undefined ? member.provider : String(body.provider ?? '').trim();
		const nextModel = body?.model === undefined ? member.model : String(body.model ?? '').trim();
		if (nextProvider === '' || nextModel === '') throw Object.assign(new Error('成员必须指定 provider 和 model'), { status: 400 });
		const nextRole = body?.role === undefined ? member.role : ROLES.has(body.role) ? body.role : null;
		if (nextRole === null) throw Object.assign(new Error(`未知角色：${String(body?.role)}`), { status: 400 });
		const otherCaptain = room.members.some((item) => item.id !== member.id && item.role === 'captain');
		if (nextRole !== 'captain' && member.role === 'captain' && !otherCaptain) {
			throw Object.assign(new Error('至少要保留一位总指挥：先把另一位成员设为总指挥，再改这一位的角色'), { status: 400 });
		}
		const nextPersona = body?.persona === undefined ? member.persona : String(body.persona ?? '').trim();
		const changes = [];
		if (nextName !== member.name) changes.push(`名称 ${member.name} → ${nextName}`);
		if (nextRole !== member.role) changes.push(`角色 ${ROLE_LABEL[member.role]} → ${ROLE_LABEL[nextRole]}`);
		if (nextProvider !== member.provider || nextModel !== member.model) changes.push(`模型 ${member.provider}/${member.model} → ${nextProvider}/${nextModel}`);
		if (nextPersona !== member.persona) changes.push('人设已更新');
		member.name = nextName;
		member.role = nextRole;
		member.provider = nextProvider;
		member.model = nextModel;
		member.persona = nextPersona;
		room.updatedAt = now();
		if (changes.length) appendMessage(room, { kind: 'system', text: `成员「${nextName}」${changes.join('；')}。` });
		saveRoom(room);
		return member;
	}

	duplicateRoom(room) {
		if (this.rooms.size >= MAX_ROOMS) {
			throw Object.assign(new Error(`群聊数量已达上限（${MAX_ROOMS}）`), { status: 400 });
		}
		const copy = {
			id: makeId('r'),
			name: `${room.name} 副本`.slice(0, MAX_ROOM_NAME),
			createdAt: now(),
			updatedAt: now(),
			seq: 0,
			members: room.members.map((member) => ({ ...member, id: makeId('m'), addedAt: now() })),
			messages: [],
			tasks: [],
			runs: [],
		};
		this.rooms.set(copy.id, copy);
		appendMessage(copy, {
			kind: 'system',
			text: `从「${room.name}」复制创建，成员 ${copy.members.length} 位，模型与分工都已保留。`,
		});
		saveRoom(copy);
		return copy;
	}

	deleteRoom(room) {
		this.stopRun(room);
		// Tombstone: an in-flight workflow still holds this object and would
		// otherwise re-create the JSON file in its `finally` block.
		room.deleted = true;
		this.rooms.delete(room.id);
		try {
			unlinkSync(roomPath(room.id));
		} catch {
			// A leftover file is harmless; the in-memory room is gone.
		}
	}

	exportRoom(room) {
		const lines = [`# ${room.name}`, '', `创建于 ${new Date(room.createdAt).toLocaleString('zh-CN')}`, ''];
		lines.push('## 成员');
		for (const member of room.members) {
			lines.push(`- ${member.name}（${ROLE_LABEL[member.role] ?? member.role}）— ${member.provider}/${member.model}`);
		}
		lines.push('', '## 对话');
		for (const message of room.messages) {
			lines.push('', `### #${message.seq} ${message.authorName ?? '系统'}`, '', message.text);
		}
		return lines.join('\n');
	}

	isRunning(room) {
		return room.runs.some((run) => run.status === 'running');
	}

	/* ---- runs ---- */

	postMessage(room, body) {
		const text = String(body?.text ?? '').trim();
		if (text === '') throw Object.assign(new Error('消息不能为空'), { status: 400 });
		if (text.length > MAX_MESSAGE_CHARS) {
			throw Object.assign(new Error(`消息最长 ${MAX_MESSAGE_CHARS} 个字符，请拆成几条发送`), { status: 400 });
		}
		const mode = body?.mode === 'chat' ? 'chat' : 'task';
		if (!room.members.length) throw Object.assign(new Error('请先添加至少一位成员'), { status: 400 });
		let directMember = null;
		const directTo = typeof body?.to === 'string' ? body.to.trim() : '';
		if (directTo !== '') {
			if (mode !== 'chat') throw Object.assign(new Error('只有聊天模式支持 @ 指定成员'), { status: 400 });
			directMember = memberByName(room, directTo);
			if (!directMember) throw Object.assign(new Error(`群聊里没有成员「${directTo}」`), { status: 400 });
		}
		if (this.isRunning(room)) throw Object.assign(new Error('上一个协作还在运行，请先停止或等待完成'), { status: 409 });
		const userMessage = appendMessage(room, { kind: 'user', authorName: '你', text });
		const run = {
			id: makeId('run'),
			mode,
			status: 'running',
			phase: mode === 'chat' ? 'chat' : 'plan',
			startedAt: now(),
			endedAt: null,
			turns: 0,
			tokens: 0,
			error: null,
			messageSeq: userMessage.seq,
			directTo: directMember ? directMember.id : null,
			directName: directMember ? directMember.name : null,
		};
		room.runs.push(run);
		if (room.runs.length > 30) room.runs.shift();
		saveRoom(room);
		const controller = new AbortController();
		this.active.set(room.id, { controller, runId: run.id });
		void this.runWorkflow(room, run, text, mode, controller.signal);
		return { ok: true, seq: userMessage.seq, run };
	}

	stopRun(room) {
		const active = this.active.get(room.id);
		if (!active) return false;
		active.controller.abort();
		return true;
	}

	async runWorkflow(room, run, text, mode, signal) {
		try {
			if (signal.aborted) throw abortError();
			if (mode === 'chat') await this.runChat(room, run, text, signal);
			else await this.runTask(room, run, text, signal);
			if (run.status === 'running') {
				run.status = 'done';
				run.phase = 'done';
			}
		} catch (error) {
			if (error?.name === 'AbortError' || signal.aborted) {
				run.status = 'stopped';
				run.error = '已手动停止';
				appendMessage(room, { kind: 'system', text: '协作已停止。' });
			} else {
				run.status = 'error';
				run.error = String(error?.message ?? error);
				appendMessage(room, { kind: 'system', text: `协作失败：${run.error}` });
			}
		} finally {
			run.endedAt = now();
			this.active.delete(room.id);
			saveRoom(room);
		}
	}

	/**
	 * Re-run one failed or blocked task without re-planning the whole room.
	 * The task is re-parented to a fresh run so the scheduler and the token
	 * accounting treat it as its own unit of work.
	 */
	retryTask(room, taskId) {
		if (this.isRunning(room)) throw Object.assign(new Error('协作运行中，请先停止或等待完成'), { status: 409 });
		const task = room.tasks.find((item) => item.id === taskId);
		if (!task) throw Object.assign(new Error('任务不存在'), { status: 404 });
		if (task.status !== 'failed' && task.status !== 'blocked') {
			throw Object.assign(new Error('只有失败或阻塞的任务可以重试'), { status: 400 });
		}
		if (!room.members.length) throw Object.assign(new Error('群聊没有成员'), { status: 400 });
		const rootText = task.rootText || task.brief || '';
		const run = {
			id: makeId('run'),
			mode: 'retry',
			status: 'running',
			phase: 'work',
			startedAt: now(),
			endedAt: null,
			turns: 0,
			tokens: 0,
			error: null,
			messageSeq: room.seq,
			directTo: null,
			directName: null,
		};
		room.runs.push(run);
		if (room.runs.length > 30) room.runs.shift();
		task.runId = run.id;
		task.status = 'pending';
		task.attempts = 0;
		task.error = null;
		// A blocked task usually waits on a dependency that failed. The user asked
		// for this one task, so run it standalone instead of re-blocking it.
		task.dependsOn = [];
		saveRoom(room);
		const controller = new AbortController();
		this.active.set(room.id, { controller, runId: run.id });
		void this.runRetry(room, run, rootText, controller.signal);
		return { ok: true, run };
	}

	async runRetry(room, run, rootText, signal) {
		try {
			await this.drainReady(room, run, rootText, signal);
			if (run.status === 'running') {
				run.status = 'done';
				run.phase = 'done';
			}
		} catch (error) {
			if (error?.name === 'AbortError' || signal.aborted) {
				run.status = 'stopped';
				run.error = '已手动停止';
				appendMessage(room, { kind: 'system', runId: run.id, text: '重试已停止。' });
			} else {
				run.status = 'error';
				run.error = String(error?.message ?? error);
				appendMessage(room, { kind: 'system', runId: run.id, text: `重试失败：${run.error}` });
			}
		} finally {
			run.endedAt = now();
			this.active.delete(room.id);
			saveRoom(room);
		}
	}

	async runChat(room, run, text, signal) {
		const captain = pickCaptain(room);
		if (!captain) throw new Error('群聊没有成员');
		const direct = run.directTo ? (room.members.find((member) => member.id === run.directTo) ?? null) : null;
		const responders = direct ? [direct] : room.members.filter((member) => member.id !== captain.id).slice(0, MAX_PARALLEL);
		run.phase = 'chat';
		saveRoom(room);
		if (responders.length) {
			const user = chatUser(room, text);
			await Promise.all(
				responders.map(async (member) => {
					try {
						const result = await this.callModel(room, run, {
							provider: member.provider,
							model: member.model,
							system: direct ? directSystem(room, member) : chatSystem(room, member),
							user: direct ? `## 用户点名问你\n${text}\n\n请完整回答。` : user,
							maxTokens: direct ? SYNTH_TOKENS : CHAT_TOKENS,
							signal,
							phase: 'chat',
						});
						appendMessage(room, {
							kind: 'member',
							authorId: member.id,
							authorName: member.name,
							role: member.role,
							runId: run.id,
							text: result.text,
							meta: { provider: member.provider, model: member.model, tokens: result.totalTokens },
						});
					} catch (error) {
						if (error?.name === 'AbortError') throw error;
						appendMessage(room, { kind: 'system', runId: run.id, text: `成员「${member.name}」暂不可用：${error?.message ?? error}` });
					}
				}),
			);
		}
		// A direct @question is answered by that member only: no captain
		// convergence, which keeps a one-to-one question cheap and precise.
		if (direct) return;
		run.phase = 'converge';
		saveRoom(room);
		const summary = await this.callModel(room, run, {
			provider: captain.provider,
			model: captain.model,
			system: converSystem(room),
			user: converUser(room, text),
			maxTokens: CHAT_TOKENS,
			signal,
			phase: 'converge',
		});
		appendMessage(room, {
			kind: 'summary',
			authorId: captain.id,
			authorName: captain.name,
			role: captain.role,
			runId: run.id,
			text: summary.text,
			meta: { provider: captain.provider, model: captain.model, tokens: summary.totalTokens },
		});
	}

	async runTask(room, run, text, signal) {
		const captain = pickCaptain(room);
		if (!captain) throw new Error('群聊没有成员');
		run.phase = 'plan';
		saveRoom(room);
		const plan = await this.makePlan(room, run, captain, text, signal);
		const tasks = this.createTasks(room, run, plan.tasks, 1, false, text);
		appendMessage(room, {
			kind: 'plan',
			authorId: captain.id,
			authorName: captain.name,
			role: captain.role,
			runId: run.id,
			text: `## 任务拆分\n${plan.analysis ? `${plan.analysis}\n\n` : ''}${tasks
				.map((task, index) => `${index + 1}. **${task.title}** → ${task.assignee}${task.dependsOn.length ? `（依赖 ${task.dependsOn.length} 项）` : ''}\n   ${truncate(task.brief, 240)}`)
				.join('\n')}`,
			meta: { tasks: tasks.map((task) => ({ id: task.id, title: task.title, assignee: task.assignee })) },
		});

		let wave = 1;
		let review = null;
		for (;;) {
			run.phase = 'work';
			saveRoom(room);
			await this.drainReady(room, run, text, signal);
			await this.retryFailed(room, run, text, signal);
			this.markBlocked(room, run);

			const reviewer = room.members.find((member) => member.role === 'reviewer' && member.id !== captain.id);
			if (!reviewer) break;
			run.phase = 'review';
			saveRoom(room);
			review = await this.makeReview(room, run, reviewer, text, signal);
			appendMessage(room, {
				kind: 'review',
				authorId: reviewer.id,
				authorName: reviewer.name,
				role: reviewer.role,
				runId: run.id,
				text: `## 质检：${review.verdict === 'pass' ? '通过' : '需要修补'}\n${review.notes || '（无备注）'}`,
				meta: { verdict: review.verdict, fixes: review.fixes, provider: reviewer.provider, model: reviewer.model },
			});
			if (review.verdict === 'pass' || wave >= MAX_WAVES) break;
			const fixes = Array.isArray(review.fixes) ? review.fixes.slice(0, 3) : [];
			if (!fixes.length) break;
			wave += 1;
			const repairTasks = this.createTasks(room, run, fixes, wave, true, text);
			if (!repairTasks.length) break;
			appendMessage(room, {
				kind: 'system',
				runId: run.id,
				text: `质检提出 ${repairTasks.length} 项修补，进入第 ${wave} 轮。`,
			});
		}

		run.phase = 'synthesize';
		saveRoom(room);
		const final = await this.callModel(room, run, {
			provider: captain.provider,
			model: captain.model,
			system: synthSystem(room),
			user: synthUser(room, text, review ? { ...review, runId: run.id } : null, run.id),
			maxTokens: SYNTH_TOKENS,
			signal,
			phase: 'synthesize',
		});
		appendMessage(room, {
			kind: 'summary',
			authorId: captain.id,
			authorName: captain.name,
			role: captain.role,
			runId: run.id,
			text: final.text,
			meta: { provider: captain.provider, model: captain.model, tokens: final.totalTokens },
		});
	}

	async makePlan(room, run, captain, text, signal) {
		const result = await this.callModel(room, run, {
			provider: captain.provider,
			model: captain.model,
			system: planSystem(room),
			user: planUser(room, text),
			maxTokens: MAX_TOKENS,
			signal,
			phase: 'plan',
		});
		const parsed = parseJsonLoose(result.text);
		const rawTasks = Array.isArray(parsed?.tasks) ? parsed.tasks.filter((task) => task && typeof task === 'object') : [];
		const analysis = typeof parsed?.analysis === 'string' ? parsed.analysis : '';
		if (!rawTasks.length) {
			const workers = room.members.filter((member) => member.id !== captain.id).slice(0, MAX_PARALLEL);
			const fallback = workers.length
				? workers.map((member) => ({
						title: `${member.name} 的独立方案`,
						brief: `从${ROLE_LABEL[member.role] ?? '成员'}视角，独立完成任务：「${text}」，给出可直接使用的成果（结论、结构、步骤与取舍理由）。不要重复其他人的视角。`,
						assignee: member.name,
						dependsOn: [],
					}))
				: [{ title: '直接交付', brief: text, assignee: captain.name, dependsOn: [] }];
			return { analysis: analysis || '总指挥未能给出结构化拆分，按成员角色并行分工。', tasks: fallback };
		}
		return {
			analysis,
			tasks: rawTasks.slice(0, 5).map((task) => ({
				title: String(task.title ?? '子任务').slice(0, 80),
				brief: String(task.brief ?? task.title ?? '').slice(0, 2000),
				assignee: String(task.assignee ?? captain.name),
				dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map((item) => String(item)) : [],
			})),
		};
	}

	createTasks(room, run, specs, wave, forceNoDeps = false, rootText = '') {
		const created = [];
		// Start from what this run already produced, so a later batch can depend
		// on an earlier batch by title as well as on its own siblings.
		const byTitle = new Map(
			room.tasks.filter((task) => task.runId === run.id).map((task) => [task.title.trim().toLowerCase(), task.id]),
		);
		for (const spec of specs) {
			const member = memberByName(room, spec.assignee) ?? pickCaptain(room);
			if (!member) continue;
			const task = {
				id: makeId('t'),
				runId: run.id,
				wave,
				title: String(spec.title ?? '子任务').slice(0, 120),
				brief: String(spec.brief ?? spec.title ?? '').slice(0, 4000),
				assignee: member.name,
				memberId: member.id,
				rootText: String(rootText ?? '').slice(0, 4000),
				dependsOn: [],
				status: 'pending',
				attempts: 0,
				result: '',
				error: null,
				createdAt: now(),
				startedAt: null,
				completedAt: null,
			};
			room.tasks.push(task);
			created.push(task);
			byTitle.set(task.title.toLowerCase(), task.id);
		}
		// Resolve title references after every task exists, so forward references work.
		for (let index = 0; index < created.length; index += 1) {
			const spec = specs[index];
			const refs = Array.isArray(spec?.dependsOn) ? spec.dependsOn : [];
			const ids = [];
			for (const ref of refs) {
				const key = String(ref).trim().toLowerCase();
				const direct = byTitle.get(key);
				if (direct) {
					ids.push(direct);
					continue;
				}
				const fuzzy = created.find((task) => task.title.toLowerCase().includes(key) || key.includes(task.title.toLowerCase()));
				if (fuzzy) ids.push(fuzzy.id);
			}
			created[index].dependsOn = [...new Set(ids.filter((id) => id !== created[index].id))];
		}
		if (forceNoDeps) {
			for (const task of created) task.dependsOn = [];
		}
		saveRoom(room);
		return created;
	}

	async drainReady(room, run, text, signal) {
		for (let guard = 0; guard < 12; guard += 1) {
			if (signal.aborted) throw abortError();
			const ready = room.tasks.filter(
				(task) => task.runId === run.id && task.status === 'pending' && task.dependsOn.every((id) => taskStatus(room, id) === 'done'),
			);
			if (!ready.length) return;
			for (let index = 0; index < ready.length; index += MAX_PARALLEL) {
				const group = ready.slice(index, index + MAX_PARALLEL);
				await Promise.all(group.map((task) => this.executeTask(room, run, task, text, signal)));
			}
		}
	}

	async retryFailed(room, run, text, signal) {
		const retryable = room.tasks.filter(
			(task) =>
				task.runId === run.id &&
				task.status === 'failed' &&
				(task.attempts ?? 0) < 2 &&
				task.dependsOn.every((id) => taskStatus(room, id) === 'done'),
		);
		if (!retryable.length) return;
		for (const task of retryable) task.status = 'pending';
		saveRoom(room);
		await this.drainReady(room, run, text, signal);
	}

	markBlocked(room, run) {
		let changed = false;
		for (const task of room.tasks) {
			if (task.runId !== run.id || task.status !== 'pending') continue;
			if (task.dependsOn.some((id) => ['failed', 'blocked', 'missing'].includes(taskStatus(room, id)))) {
				task.status = 'blocked';
				task.error = '前置任务未成功，无法继续';
				changed = true;
			}
		}
		if (changed) saveRoom(room);
	}

	async executeTask(room, run, task, rootText, signal) {
		// Prefer the stable member id: the assignee name may have been renamed
		// since the task was created.
		const member = room.members.find((item) => item.id === task.memberId) ?? memberByName(room, task.assignee) ?? pickCaptain(room);
		if (!member) throw new Error('没有可用的执行成员');
		task.status = 'running';
		task.attempts = (task.attempts ?? 0) + 1;
		task.assignee = member.name;
		task.memberId = member.id;
		task.startedAt = now();
		saveRoom(room);
		try {
			const result = await this.callModel(room, run, {
				provider: member.provider,
				model: member.model,
				system: workerSystem(room, member),
				user: workerUser(room, task, rootText),
				maxTokens: MAX_TOKENS,
				signal,
				phase: 'work',
			});
			task.result = result.text;
			task.status = 'done';
			task.completedAt = now();
			task.error = null;
			appendMessage(room, {
				kind: 'member',
				authorId: member.id,
				authorName: member.name,
				role: member.role,
				taskId: task.id,
				runId: run.id,
				text: result.text,
				meta: {
					provider: member.provider,
					model: member.model,
					tokens: result.totalTokens,
					taskTitle: task.title,
					wave: task.wave,
				},
			});
		} catch (error) {
			if (error?.name === 'AbortError') {
				task.status = 'pending';
				saveRoom(room);
				throw error;
			}
			task.status = 'failed';
			task.error = String(error?.message ?? error);
			appendMessage(room, {
				kind: 'system',
				runId: run.id,
				taskId: task.id,
				text: `成员「${member.name}」执行「${task.title}」失败：${task.error}`,
			});
		}
	}

	async makeReview(room, run, reviewer, text, signal) {
		const tasks = room.tasks.filter((task) => task.runId === run.id && task.wave >= 1);
		const result = await this.callModel(room, run, {
			provider: reviewer.provider,
			model: reviewer.model,
			system: reviewSystem(room),
			user: reviewUser(room, text, tasks),
			maxTokens: MAX_TOKENS,
			signal,
			phase: 'review',
		});
		const parsed = parseJsonLoose(result.text);
		const verdict = parsed?.verdict === 'pass' ? 'pass' : 'revise';
		const fixes = Array.isArray(parsed?.fixes)
			? parsed.fixes
					.filter((fix) => fix && typeof fix === 'object')
					.map((fix) => ({
						title: String(fix.title ?? '修补').slice(0, 100),
						brief: String(fix.brief ?? '').slice(0, 2000),
						assignee: String(fix.assignee ?? ''),
						dependsOn: [],
					}))
			: [];
		return { verdict, notes: String(parsed?.notes ?? truncate(result.text, 800)), fixes };
	}

	async callModel(room, run, options) {
		if (room.deleted) throw abortError('群聊已删除');
		if (run.turns >= MAX_TURNS_PER_RUN) throw new Error(`本轮协作达到 ${MAX_TURNS_PER_RUN} 次模型调用上限，已保留现有产出`);
		if (options.signal?.aborted) throw abortError();
		run.phase = options.phase ?? run.phase;
		const result = await this.streamText(options);
		run.turns += 1;
		run.tokens += result.totalTokens ?? 0;
		saveRoom(room);
		return result;
	}

	async streamText({ provider, model, system, user, maxTokens, signal }) {
		if (!provider || !model) throw new Error('成员缺少 provider / model');
		let text = '';
		let reasoning = '';
		let usage = null;
		let finish = null;
		const request = {
			provider,
			model,
			system,
			messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
			maxTokens,
			signal,
		};
		for await (const chunk of this.ctx.llm.stream(request)) {
			if (chunk.type === 'text-delta') text += chunk.text;
			else if (chunk.type === 'reasoning-delta') reasoning += chunk.text;
			else if (chunk.type === 'usage') usage = chunk.usage;
			else if (chunk.type === 'finish') finish = chunk.reason;
		}
		if (finish?.kind === 'error') throw new Error(`模型调用失败（${provider}/${model}）：${finish.failure?.message ?? '未知错误'}`);
		if (finish?.kind === 'aborted') throw abortError(finish.failure?.message);
		// Reasoning models can spend the whole budget on hidden reasoning and emit
		// no visible text. Their reasoning is still real output, so use it rather
		// than failing the task and blocking every dependent task.
		const clean = text.trim() || reasoning.trim();
		if (clean === '') {
			const why = finish?.kind === 'max-tokens' ? 'token 预算耗尽且无正文' : '空内容';
			throw new Error(`模型（${provider}/${model}）返回${why}`);
		}
		return {
			text: clean,
			usage,
			totalTokens: usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
		};
	}
}

function abortError(message = '已中止') {
	const error = new Error(message);
	error.name = 'AbortError';
	return error;
}

export function apply(ctx) {
	const engine = new Grokbot(ctx);
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'prefix',
				path: API_PREFIX,
				handler: (req, res) => engine.handle(req, res),
			}),
		'grokbot: http api',
	);
}

export { Grokbot };
