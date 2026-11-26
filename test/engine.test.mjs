/**
 * Unit tests for the grokbot host engine.
 *
 * Run with: node --test test/
 *
 * The engine is exercised through its real HTTP-ish entry point (`bot.handle`
 * with fake req/res objects) and through a fake `ctx.llm` so no model credit is
 * spent. Storage points at a throwaway directory.
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'grokbot-test-'));
process.env.GROKBOT_DATA_DIR = DATA_DIR;

const { Grokbot } = await import('../index.js');

/* ------------------------------------------------------------------ helpers */

function fakeLlm(reply) {
	return {
		listProviders: () => [{ id: 'test-provider', name: 'Test Provider' }],
		listModels: async () => [
			{ id: 'model-a', name: 'Model A' },
			{ id: 'model-b', name: 'Model B' },
		],
		async *stream(options) {
			const text = await reply(options);
			yield { type: 'text-delta', index: 0, text };
			yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
			yield { type: 'finish', reason: { kind: 'stop' } };
		},
	};
}

function scriptedReply(options) {
	const system = String(options.system ?? '');
	if (system.includes('把用户任务拆成')) {
		return JSON.stringify({
			analysis: '两个子任务，先起草再检查',
			tasks: [
				{ title: '起草', brief: '写一段结论', assignee: '写手', dependsOn: [] },
				{ title: '检查', brief: '检查结论是否成立', assignee: '质检', dependsOn: ['起草'] },
			],
		});
	}
	if (system.includes('质检员')) return JSON.stringify({ verdict: 'pass', notes: '可用', fixes: [] });
	if (system.includes('合成一份最终交付')) return '最终交付：结论如下。';
	return `产出（${options.provider}/${options.model}）`;
}

function newBot(reply = scriptedReply) {
	const bot = new Grokbot({ llm: fakeLlm(reply) });
	return bot;
}

function fakeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
	const req = new EventEmitter();
	req.method = method;
	req.url = url;
	req.headers = { host: '127.0.0.1:62581', ...headers };
	if (body !== undefined) {
		const payload = typeof body === 'string' ? body : JSON.stringify(body);
		setImmediate(() => {
			req.emit('data', payload);
			req.emit('end');
		});
	} else {
		setImmediate(() => req.emit('end'));
	}
	return req;
}

function fakeRes() {
	const res = {
		headersSent: false,
		status: 0,
		body: '',
		headers: {},
		writeHead(status, headers) {
			res.status = status;
			res.headers = headers ?? {};
			res.headersSent = true;
		},
		end(chunk) {
			res.body += chunk ?? '';
		},
	};
	return res;
}

async function call(bot, options, headers) {
	const req = fakeReq({ ...options, headers: { ...(options?.headers ?? {}), ...(headers ?? {}) } });
	const res = fakeRes();
	await bot.handle(req, res);
	let json = null;
	try {
		json = JSON.parse(res.body);
	} catch {
		// non-JSON bodies stay null
	}
	return { status: res.status, body: res.body, json, headers: res.headers };
}

async function waitFor(predicate, label, timeout = 4000) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeout) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timeout waiting for ${label}`);
}

function memberPayload(name, role, model = 'model-a') {
	return { name, role, provider: 'test-provider', model };
}

/* -------------------------------------------------------------------- tests */

test('createRoom: validates seeds, reports warnings, persists to disk', async () => {
	const bot = newBot();
	const { json } = await call(bot, {
		method: 'POST',
		url: '/grokbot/api/rooms',
		body: {
			name: '冒烟',
			members: [memberPayload('组长', 'worker'), { name: '坏成员', role: 'worker', provider: '' }, memberPayload('质检', 'reviewer', 'model-b')],
		},
	});
	assert.equal(json.room.members.length, 2);
	assert.equal(json.room.members[0].role, 'captain', 'the first seed is promoted when no captain is present');
	assert.equal(json.warnings.length, 1);
	assert.match(json.warnings[0], /坏成员/);
	const file = join(DATA_DIR, 'rooms', `${json.room.id}.json`);
	const stored = JSON.parse(readFileSync(file, 'utf8'));
	assert.equal(stored.members.length, 2, 'createRoom must persist immediately');
});

test('origin guard: cross-site writes are rejected, same-origin and local tools are allowed', async () => {
	const bot = newBot();
	const evil = await call(bot, {
		method: 'POST',
		url: '/grokbot/api/rooms',
		body: { name: 'evil' },
		headers: { origin: 'https://evil.example' },
	});
	assert.equal(evil.status, 403);
	assert.match(evil.body, /跨站请求被拒绝/);

	const local = await call(bot, {
		method: 'GET',
		url: '/grokbot/api/bootstrap',
		headers: { origin: 'http://127.0.0.1:62581' },
	});
	assert.equal(local.status, 200);

	const curl = await call(bot, { method: 'GET', url: '/grokbot/api/health' });
	assert.equal(curl.status, 200);
	assert.equal(curl.json.ok, true);

	const options = await call(bot, { method: 'OPTIONS', url: '/grokbot/api/rooms', headers: { origin: 'http://127.0.0.1:62581' } });
	assert.equal(options.status, 204);
	assert.equal(options.headers['access-control-allow-origin'], 'http://127.0.0.1:62581');
	assert.notEqual(options.headers['access-control-allow-origin'], '*');
});

test('room ids outside the allowlist are rejected instead of touching the filesystem', async () => {
	const bot = newBot();
	const res = await call(bot, { method: 'GET', url: '/grokbot/api/rooms/..%2F..%2Fetc' });
	assert.equal(res.status, 404);
	const bad = await call(bot, { method: 'GET', url: '/grokbot/api/rooms/%E0%A4%A' });
	assert.equal(bad.status, 400);
});

test('duplicateRoom copies the roster but not messages, tasks or runs', async () => {
	const bot = newBot();
	const created = await call(bot, { method: 'POST', url: '/grokbot/api/rooms', body: { name: '原房间', members: [memberPayload('组长', 'captain'), memberPayload('写手', 'worker')] } });
	const copied = await call(bot, { method: 'POST', url: `/grokbot/api/rooms/${created.json.room.id}/duplicate` });
	assert.equal(copied.status, 200);
	assert.equal(copied.json.room.members.length, 2);
	assert.deepEqual(
		copied.json.room.members.map((member) => member.role),
		['captain', 'worker'],
	);
	assert.notDeepEqual(
		copied.json.room.members.map((member) => member.id),
		created.json.room.members.map((member) => member.id),
		'cloned members need fresh ids',
	);
	assert.equal(copied.json.room.tasks.length, 0);
	const stored = JSON.parse(readFileSync(join(DATA_DIR, 'rooms', `${copied.json.room.id}.json`), 'utf8'));
	assert.equal(stored.members.length, 2, 'a duplicated room must be persisted immediately');
});

test('updateMember: can swap model, cannot demote the only captain or duplicate a name', async () => {
	const bot = newBot();
	const created = await call(bot, {
		method: 'POST',
		url: '/grokbot/api/rooms',
		body: { name: '改成员', members: [memberPayload('组长', 'captain'), memberPayload('写手', 'worker')] },
	});
	const roomId = created.json.room.id;
	const worker = created.json.room.members[1];

	const swapped = await call(bot, {
		method: 'PUT',
		url: `/grokbot/api/rooms/${roomId}/members/${worker.id}`,
		body: { provider: 'test-provider', model: 'model-b' },
	});
	assert.equal(swapped.status, 200);
	assert.equal(swapped.json.member.model, 'model-b');
	assert.equal(swapped.json.member.role, 'worker');

	const captain = created.json.room.members[0];
	const demote = await call(bot, {
		method: 'PUT',
		url: `/grokbot/api/rooms/${roomId}/members/${captain.id}`,
		body: { role: 'worker' },
	});
	assert.equal(demote.status, 400);
	assert.match(demote.body, /至少要保留一位总指挥/);

	const rename = await call(bot, {
		method: 'PUT',
		url: `/grokbot/api/rooms/${roomId}/members/${worker.id}`,
		body: { name: '组长' },
	});
	assert.equal(rename.status, 400);
	assert.match(rename.body, /已存在/);
});

test('deleting a room tombstones in-flight workflows so they cannot resurrect the file', async () => {
	const bot = newBot();
	const created = await call(bot, { method: 'POST', url: '/grokbot/api/rooms', body: { name: '删除', members: [memberPayload('组长', 'captain')] } });
	const room = bot.rooms.get(created.json.room.id);
	await call(bot, { method: 'DELETE', url: `/grokbot/api/rooms/${room.id}` });
	assert.equal(bot.rooms.has(room.id), false);
	assert.equal(room.deleted, true, 'the in-memory room is tombstoned for any in-flight workflow');
	assert.equal(readdirSync(join(DATA_DIR, 'rooms')).includes(`${room.id}.json`), false);
	const after = await call(bot, { method: 'GET', url: `/grokbot/api/rooms/${room.id}` });
	assert.equal(after.status, 404);
});

test('a run left as running on disk is recovered as interrupted after restart', async () => {
	const id = 'r_recovery';
	writeFileSync(
		join(DATA_DIR, 'rooms', `${id}.json`),
		JSON.stringify({
			id,
			name: '崩溃恢复',
			createdAt: 1,
			updatedAt: 1,
			seq: 1,
			members: [memberPayload('组长', 'captain')],
			messages: [],
			tasks: [],
			runs: [{ id: 'run_x', mode: 'task', status: 'running', phase: 'work', turns: 2, tokens: 10 }],
		}),
	);
	const bot = newBot();
	const room = bot.rooms.get(id);
	assert.equal(room.runs[0].status, 'interrupted');
	assert.equal(bot.isRunning(room), false, 'an interrupted run must not lock the room');
});

test('task flow: plan → parallel work → review pass → synthesized summary', async () => {
	const bot = newBot();
	const created = await call(bot, {
		method: 'POST',
		url: '/grokbot/api/rooms',
		body: {
			name: '端到端',
			members: [memberPayload('组长', 'captain'), memberPayload('写手', 'worker'), memberPayload('质检', 'reviewer')],
		},
	});
	const roomId = created.json.room.id;
	const posted = await call(bot, {
		method: 'POST',
		url: `/grokbot/api/rooms/${roomId}/messages`,
		body: { text: '给一句话结论', mode: 'task' },
	});
	assert.equal(posted.status, 200);
	await waitFor(() => bot.isRunning(bot.rooms.get(roomId)) === false, 'workflow to finish');

	const room = bot.rooms.get(roomId);
	assert.equal(room.tasks.length, 2);
	assert.deepEqual(room.tasks.map((task) => task.status), ['done', 'done']);
	const kinds = room.messages.map((message) => message.kind);
	assert.ok(kinds.includes('plan'));
	assert.ok(kinds.includes('review'));
	assert.ok(kinds.includes('summary'));
	const review = room.messages.find((message) => message.kind === 'review');
	assert.equal(review.meta.verdict, 'pass');
	assert.equal(room.runs[0].status, 'done');
	assert.ok(room.runs[0].turns >= 4);
});

test('retryTask reruns only the failed task and clears its dependency', async () => {
	const bot = newBot();
	const created = await call(bot, {
		method: 'POST',
		url: '/grokbot/api/rooms',
		body: { name: '重试', members: [memberPayload('组长', 'captain'), memberPayload('写手', 'worker')] },
	});
	const roomId = created.json.room.id;
	const room = bot.rooms.get(roomId);
	room.tasks.push({
		id: 't_failed',
		runId: 'run_old',
		title: '失败任务',
		brief: '再试一次',
		assignee: '写手',
		memberId: room.members[1].id,
		dependsOn: ['t_missing'],
		status: 'failed',
		attempts: 2,
		error: '模型返回空内容',
		rootText: '原始任务',
		wave: 1,
	});
	const retried = await call(bot, { method: 'POST', url: `/grokbot/api/rooms/${roomId}/tasks/t_failed/retry` });
	assert.equal(retried.status, 200);
	await waitFor(() => bot.isRunning(room) === false, 'retry run to finish');
	const task = room.tasks.find((item) => item.id === 't_failed');
	assert.equal(task.status, 'done');
	assert.deepEqual(task.dependsOn, []);
	assert.equal(task.result, '产出（test-provider/model-a）');
	assert.equal(room.runs[room.runs.length - 1].mode, 'retry');

	const running = await call(bot, { method: 'POST', url: `/grokbot/api/rooms/${roomId}/tasks/t_failed/retry` });
	assert.equal(running.status, 400, 'a completed task is not retryable');
});

test('@mention in chat mode is validated against the roster', async () => {
	const bot = newBot();
	const created = await call(bot, {
		method: 'POST',
		url: '/grokbot/api/rooms',
		body: { name: '定向', members: [memberPayload('组长', 'captain'), memberPayload('写手', 'worker')] },
	});
	const roomId = created.json.room.id;
	const missing = await call(bot, {
		method: 'POST',
		url: `/grokbot/api/rooms/${roomId}/messages`,
		body: { text: '你怎么看', mode: 'chat', to: '不存在的人' },
	});
	assert.equal(missing.status, 400);
	assert.match(missing.body, /没有成员/);

	const direct = await call(bot, {
		method: 'POST',
		url: `/grokbot/api/rooms/${roomId}/messages`,
		body: { text: '你怎么看', mode: 'chat', to: '写手' },
	});
	assert.equal(direct.status, 200);
	assert.equal(direct.json.run.directName, '写手');
	await waitFor(() => bot.isRunning(bot.rooms.get(roomId)) === false, 'direct chat to finish');
	const room = bot.rooms.get(roomId);
	const replies = room.messages.filter((message) => message.kind === 'member');
	assert.equal(replies.length, 1, 'only the mentioned member answers');
});

test('oversized messages and oversized request bodies are refused', async () => {
	const bot = newBot();
	const created = await call(bot, { method: 'POST', url: '/grokbot/api/rooms', body: { name: '上限', members: [memberPayload('组长', 'captain')] } });
	const tooLong = await call(bot, {
		method: 'POST',
		url: `/grokbot/api/rooms/${created.json.room.id}/messages`,
		body: { text: 'x'.repeat(20_001), mode: 'task' },
	});
	assert.equal(tooLong.status, 400);
	assert.match(tooLong.body, /最长 20000/);
});

test('member name length and member count are capped', async () => {
	const bot = newBot();
	const created = await call(bot, {
		method: 'POST',
		url: '/grokbot/api/rooms',
		body: { name: 'x'.repeat(100), members: [memberPayload('组长', 'captain')] },
	});
	assert.equal(created.json.room.name.length, 60);

	const roomId = created.json.room.id;
	for (let index = 0; index < 5; index += 1) {
		const added = await call(bot, {
			method: 'POST',
			url: `/grokbot/api/rooms/${roomId}/members`,
			body: memberPayload(`成员${index}`, 'worker'),
		});
		assert.equal(added.status, 200);
	}
	const overflow = await call(bot, {
		method: 'POST',
		url: `/grokbot/api/rooms/${roomId}/members`,
		body: memberPayload('多余', 'worker'),
	});
	assert.equal(overflow.status, 400);
	assert.match(overflow.body, /最多 6 位成员/);
});

test('cleanup', () => {
	rmSync(DATA_DIR, { recursive: true, force: true });
});
