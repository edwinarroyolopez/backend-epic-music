import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

test('preview HTTP contract: no-store, structured provider failures, Retry-After, invalid cursor and JWT', async () => {
    let calls = 0, aiCalls = 0;
    const server = createApp({ personality: {
        callAI: async () => { aiCalls++; throw new Error('Unexpected AI'); },
        youtube: { enabled: true, apiKey: 'synthetic-private-key', timeoutMs: 30, fetchImpl: async (url, { signal }) => {
            calls++;
            const id = url.searchParams.get('id') || url.searchParams.get('playlistId');
            const status = Number(id.slice(-3));
            if (status === 408) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
            if (status !== 200) return Response.json({ error: { errors: [{ reason: 'synthetic' }] } }, { status, headers: { 'Retry-After': '2' } });
            return Response.json(url.pathname.endsWith('/playlists') ? { items: [{ snippet: { title: 'HTTP fixture' } }] } : { items: [], pageInfo: { totalResults: 0 } });
        } },
    } }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (body, authorization) => {
        const response = await fetch(`${base}/playlist-personality/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization && { Authorization: authorization }) }, body: JSON.stringify({ sourceMode: 'link', ...body }) });
        const json = await response.json();
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.ok(!JSON.stringify(json).includes('synthetic-private-key'));
        return { response, json };
    };
    try {
        const url = code => `https://youtube.com/playlist?list=PLsynthetic${code}`;
        for (const [code, state] of [[200, 'preview_ready'], [401, 'auth_required'], [403, 'permission_denied'], [404, 'not_found'], [408, 'provider_error'], [500, 'provider_error'], [429, 'rate_limited']]) {
            const { response, json } = await request({ url: url(code) });
            assert.equal(response.status, 200); // Successful capability request, NOT an imported playlist.
            assert.equal(json.data.status, state); assert.equal(json.data.import, false); assert.equal(json.data.analysis, false);
            if (code !== 200) assert.equal(json.data.preview, undefined);
            if (code === 408) assert.equal(json.data.messageCode, 'YOUTUBE_TIMEOUT');
            if (code === 429) { assert.equal(response.headers.get('retry-after'), '2'); assert.equal(json.data.retryAfter, 2); }
        }
        const beforeCooldown = calls;
        assert.equal((await request({ url: url(200) })).json.data.status, 'rate_limited'); assert.equal(calls, beforeCooldown);
        assert.equal((await request({ url: url(200), nextPageToken: 'forged' })).response.status, 400);
        assert.equal((await request({ url: 'https://youtube.com.evil.test/playlist?list=PLsynthetic200' })).response.status, 400);
        assert.equal((await request({ url: url(200) }, 'Bearer invalid')).response.status, 401);
        assert.equal(calls, beforeCooldown); assert.equal(aiCalls, 0);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
