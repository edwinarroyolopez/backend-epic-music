import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaylistPreview } from '../src/services/youtube-playlist-adapter.service.js';
import { createPersonalityService } from '../src/services/playlist-personality.service.js';
import { songInputs } from '../src/services/playlist.service.js';

const url = 'https://youtube.com/playlist?list=PLsynthetic12345';
const metadata = { items: [{ snippet: { title: 'Synthetic playlist' } }] };
const row = i => ({ snippet: { title: `Provider synthetic ${i}`, videoOwnerChannelTitle: 'Synthetic channel' }, contentDetails: { videoId: 'abcdefghijk' } });
const page = (items = [row(1)], extra = {}) => ({ items, pageInfo: { totalResults: items.length }, ...extra });
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const options = fetchImpl => ({ enabled: true, apiKey: 'synthetic-key', fetchImpl });

test('official requests, metadata/items pagination, scoped opaque cursor, max 500, no auto-fetch', async () => {
    const requests = [];
    const adapter = createPlaylistPreview(options(async (target, init) => {
        requests.push({ target, init });
        assert.equal(target.origin, 'https://www.googleapis.com'); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
        assert.equal(target.searchParams.has('key'), false); assert.equal(init.headers['X-Goog-Api-Key'], 'synthetic-key');
        return response(target.pathname.endsWith('/playlists') ? metadata : page(Array.from({ length: 50 }, (_, i) => row(i)), { nextPageToken: 'API-token', pageInfo: { totalResults: 900 } }));
    }));
    let result = await adapter.retrieve({ url }, { scope: 'A' });
    assert.equal(requests.length, 2); assert.equal(result.preview.items.length, 50); assert.equal(result.status, 'preview_ready');
    assert.equal(result.sourceProvenance, 'provider_api_metadata'); assert.equal(result.analysis, false);
    assert.notEqual(result.nextPageToken, 'API-token'); assert.equal(result.totalItems, 900);
    await assert.rejects(adapter.retrieve({ url, nextPageToken: result.nextPageToken }, { scope: 'B' }), /INVALID_PAGE_TOKEN/);
    await assert.rejects(adapter.retrieve({ url: url.replace('12345', '98765'), nextPageToken: result.nextPageToken }, { scope: 'A' }), /INVALID_PAGE_TOKEN/);
    await assert.rejects(adapter.retrieve({ url, nextPageToken: 'https://evil.test' }), /INVALID_PAGE_TOKEN/);
    for (let i = 1; i < 10; i++) result = await adapter.retrieve({ url, nextPageToken: result.nextPageToken }, { scope: 'A' });
    assert.equal(requests.length, 11); assert.equal(result.nextPageToken, null); assert.equal(result.truncated, true);
    assert.equal(requests[2].target.searchParams.get('pageToken'), 'API-token');
});
test('configuration, radio, video, Spotify produce no metadata or AI calls', async () => {
    let calls = 0;
    const adapter = createPlaylistPreview(options(() => { calls++; throw new Error(); }));
    for (const input of ['https://youtube.com/watch?v=abcdefghijk&list=RDabcdefghijk&start_radio=1', 'https://youtu.be/abcdefghijk', 'https://open.spotify.com/playlist/0000000000000000000000']) assert.equal((await adapter.retrieve({ url: input })).preview, undefined);
    assert.equal((await createPlaylistPreview({ ...options(() => { calls++; }), apiKey: '' }).retrieve({ url })).status, 'configuration_required');
    assert.equal(calls, 0);
});
test('empty/private/deleted rows and missing playlist are honest', async () => {
    const run = data => createPlaylistPreview(options(async u => response(u.pathname.endsWith('/playlists') ? metadata : data))).retrieve({ url });
    const empty = await run(page([])); assert.equal(empty.messageCode, 'YOUTUBE_EMPTY_PLAYLIST'); assert.deepEqual(empty.preview.items, []);
    const missing = await createPlaylistPreview(options(async () => response({ items: [] }))).retrieve({ url }); assert.equal(missing.status, 'not_found');
    const removed = await run(page([{ snippet: { title: 'Private video' }, contentDetails: { videoId: 'abcdefghijk' } }, { snippet: { title: 'Deleted video' } }]));
    assert.ok(removed.preview.items.every(i => i.availability === 'unavailable' && !i.url));
});
test('HTTP 401/403/404/429/500/quota, Retry-After cooldown and budget', async () => {
    for (const [http, status] of [[401, 'auth_required'], [403, 'permission_denied'], [404, 'not_found'], [429, 'rate_limited'], [500, 'provider_error']]) {
        let calls = 0;
        const adapter = createPlaylistPreview(options(async () => { calls++; return response({ error: {} }, http, { 'Retry-After': '120' }); }));
        const result = await adapter.retrieve({ url }); assert.equal(result.status, status); assert.equal(result.preview, undefined);
        if (http === 429) { assert.equal(result.retryAfter, 120); await adapter.retrieve({ url }); assert.equal(calls, 1); }
    }
    const quota = await createPlaylistPreview(options(async () => response({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403))).retrieve({ url });
    assert.equal(quota.status, 'rate_limited');
    let calls = 0;
    const budget = createPlaylistPreview({ ...options(async () => { calls++; return response(metadata); }), hourlyBudget: 1 });
    assert.equal((await budget.retrieve({ url })).status, 'rate_limited'); assert.equal(calls, 1);
});
test('timeouts, explicit abort, malformed/oversized bodies, network failures and redirects fail closed', async () => {
    const waiting = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    const timeout = await createPlaylistPreview({ ...options(waiting), timeoutMs: 10 }).retrieve({ url }); assert.equal(timeout.messageCode, 'YOUTUBE_TIMEOUT');
    const controller = new AbortController();
    const request = createPlaylistPreview(options(waiting)).retrieve({ url }, { signal: controller.signal });
    controller.abort(); await assert.rejects(request);
    for (const transport of [async () => { throw new TypeError('Network'); }, async () => new Response('bad JSON'), async () => new Response('x'.repeat(524289)), async () => new Response('', { status: 302, headers: { location: 'https://evil.test' } })]) {
        const result = await createPlaylistPreview(options(transport)).retrieve({ url }); assert.equal(result.status, 'provider_error'); assert.equal(result.preview, undefined);
    }
});
test('known provider rows cannot be relabelled, consented, stripped or saved via playlists', async () => {
    const external = await createPlaylistPreview(options(async u => response(u.pathname.endsWith('/playlists') ? metadata : page()))).retrieve({ url });
    const item = external.preview.items[0]; let aiCalls = 0;
    const analyze = createPersonalityService({ callAI: () => { aiCalls++; } });
    for (const override of [
        { sourceMode: 'link', url }, { sourceProvenance: 'provider_api_metadata' }, { provider: 'youtube' },
        { songs: [item] }, { songs: [{ title: item.title, artist: item.channelTitle, provenance: 'user_independent' }] },
        { songs: [{ title: item.title, artist: item.channelTitle }] }, { songs: [{ title: 'Other', artist: 'Own', songId: '012345678901234567890123' }] },
    ]) await assert.rejects(analyze({ sourceMode: 'manual', consent: true, independentSource: true, ...override }), /SOURCE_PROVENANCE_RESTRICTED/);
    assert.throws(() => songInputs([{ title: item.title, artist: item.channelTitle, originType: 'identified' }]), /SOURCE_PROVENANCE_RESTRICTED/);
    assert.equal(aiCalls, 0);
});
