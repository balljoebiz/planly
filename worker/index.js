/**
 * Planly on Cloudflare Workers — sync API plus the static app.
 *
 * The upstream project ships `functions/api/sync.js` for Cloudflare **Pages**
 * Functions. This Worker speaks the exact same protocol, so the client
 * (`apiURL()` → same-origin `/api/sync`) needs no changes:
 *
 *   GET  /api/sync?code=XXX            → { version, updatedAt, doc }
 *   PUT  /api/sync?code=XXX {base,doc} → 200 { version } | 409 { version, doc } when the server is ahead
 *
 * Everything that is not /api/sync is handed to the static assets built into dist/.
 */
const CODE_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_BODY = 1024 * 1024; // 1 MB per document
const TTL = 400 * 24 * 60 * 60; // 400 days after the last write

const json = (obj, status = 200) =>
	new Response(JSON.stringify(obj), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
	});

const norm = (c) => String(c || '').trim().toUpperCase().replace(/_/g, '-');
const keyOf = (code) => 'doc:' + code;

/* Optional allowlist — set ALLOWED_CODES (comma separated) as a secret to make the
   server invite-only. Unset or empty means any well-formed code is accepted. */
function allowed(code, env) {
	const list = String((env && env.ALLOWED_CODES) || '').split(',').map(norm).filter(Boolean);
	return list.length === 0 || list.indexOf(code) !== -1;
}

async function handleSync(request, env) {
	const code = norm(new URL(request.url).searchParams.get('code') || '');
	if (!CODE_RE.test(code)) return json({ error: 'bad_code' }, 400);
	if (!allowed(code, env)) return json({ error: 'not_allowed' }, 403);
	if (!env.PLANLY_SYNC) return json({ error: 'no_kv_binding' }, 503);

	if (request.method === 'GET') {
		const raw = await env.PLANLY_SYNC.get(keyOf(code));
		if (!raw) return json({ version: 0, updatedAt: 0, doc: null });
		return new Response(raw, {
			headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
		});
	}

	if (request.method === 'PUT') {
		const text = await request.text();
		if (text.length > MAX_BODY) return json({ error: 'too_large' }, 413);

		let body;
		try { body = JSON.parse(text); } catch { return json({ error: 'bad_json' }, 400); }
		if (!body || typeof body.doc !== 'object' || body.doc === null) return json({ error: 'bad_doc' }, 400);

		const raw = await env.PLANLY_SYNC.get(keyOf(code));
		const current = raw ? JSON.parse(raw) : { version: 0, updatedAt: 0, doc: null };
		const base = Number(body.base) || 0;

		if (base !== current.version) return json(current, 409); // client merges and retries

		const next = { version: current.version + 1, updatedAt: Date.now(), doc: body.doc };
		await env.PLANLY_SYNC.put(keyOf(code), JSON.stringify(next), { expirationTtl: TTL });
		return json({ version: next.version, updatedAt: next.updatedAt });
	}

	return json({ error: 'method_not_allowed' }, 405);
}

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		if (pathname === '/api/sync') return handleSync(request, env);
		if (env.ASSETS) return env.ASSETS.fetch(request);
		return new Response('not found', { status: 404 });
	}
};
