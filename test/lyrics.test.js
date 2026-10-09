import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupLyrics } from '../src/services/lyrics.service.js';
import { songLinks } from '../src/services/song-links.js';
import { createApp } from '../src/app.js';

const song = { title: 'Synthetic & Song / 一', artist: 'Fixture + Artist' };
const fixture = { trackName: song.title, artistName: song.artist, plainLyrics: 'Synthetic first line\nSynthetic final line', instrumental: false };
test('platform links encode metadata as search terms and never as trusted provider IDs', () => {
    const links = songLinks(song), query = `${song.title} ${song.artist}`;
    assert.equal(new URL(links.youtube).searchParams.get('search_query'), query);
    assert.equal(decodeURIComponent(new URL(links.spotify).pathname.slice('/search/'.length)), query);
    assert.equal(new URL(links.appleMusic).searchParams.get('term'), query);
    assert.deepEqual(Object.values(links).map(link => new URL(link).protocol), ['https:', 'https:', 'https:']);
});
test('lyrics lookup uses only fixed LRCLIB origin and metadata; exact match, missing and instrumental states', async () => {
    const data = await lookupLyrics(song, { fetchImpl: async (url, options) => {
        assert.equal(url.origin, 'https://lrclib.net'); assert.equal(url.pathname, '/api/get');
        assert.equal(url.searchParams.get('track_name'), song.title); assert.equal(url.searchParams.get('artist_name'), song.artist);
        assert.equal(options.headers.Authorization, undefined); assert.equal(options.redirect, 'error');
        return Response.json(fixture);
    } });
    assert.equal(data.status, 'available'); assert.equal(data.lyrics, fixture.plainLyrics);
    for (const response of [new Response(null, { status: 404 }), Response.json({ ...fixture, artistName: 'Another artist' }), Response.json({ ...fixture, plainLyrics: null })]) {
        assert.equal((await lookupLyrics(song, { fetchImpl: async () => response })).status, 'not_found');
    }
    assert.equal((await lookupLyrics(song, { fetchImpl: async () => Response.json({ ...fixture, instrumental: true }) })).status, 'instrumental');
});
test('provider failures, oversized bodies and malformed payloads are bounded errors, not fabricated lyrics', async () => {
    for (const response of [new Response(null, { status: 500 }), new Response('invalid JSON'), Response.json({}), Response.json({ ...fixture, plainLyrics: 'x'.repeat(60001) }), new Response('x'.repeat(270000))]) {
        await assert.rejects(lookupLyrics(song, { fetchImpl: async () => response }), { code: 'LYRICS_UNAVAILABLE', status: 503 });
    }
    const stalled = async (_url, { signal }) => new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture guard')), 1000);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    await assert.rejects(lookupLyrics(song, { fetchImpl: stalled, timeoutMs: 5 }), { code: 'LYRICS_UNAVAILABLE' });
    const controller = new AbortController();
    const pending = lookupLyrics(song, { fetchImpl: stalled, signal: controller.signal }); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
});
test('public lyrics HTTP validates inputs, no-store, safe errors and rate limits without Mongo or AI', async () => {
    let calls = 0;
    const server = createApp({ lyrics: input => { calls++; return lookupLyrics(input, { fetchImpl: async () => input.title === 'fail' ? new Response(null, { status: 500 }) : Response.json(fixture) }); } }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/songs/lyrics`;
    try {
        for (const query of ['', '?title=a', '?title=a&artist=', `?title=${'x'.repeat(201)}&artist=a`, '?title=a&title=b&artist=c']) assert.equal((await fetch(base + query)).status, 400);
        assert.equal(calls, 0);
        const response = await fetch(`${base}?${new URLSearchParams(song)}`);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await response.json()).data.lyrics, fixture.plainLyrics);
        const failure = await fetch(`${base}?title=fail&artist=fixture`);
        assert.equal(failure.status, 503); assert.equal((await failure.json()).error.code, 'LYRICS_UNAVAILABLE');
        let limited = false;
        for (let i = 0; i < 121; i++) if ((await fetch(`${base}?${new URLSearchParams(song)}`)).status === 429) { limited = true; break; }
        assert.ok(limited);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
test('HTTP forwards explicit refetch and rejects ambiguous or malformed retry flags', async () => {
    const calls = [];
    const server = createApp({ lyrics: (input, options) => { calls.push({ input, options }); return { ...input, status: 'not_found', lyrics: null }; } }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/songs/lyrics?${new URLSearchParams(song)}`;
    try {
        for (const flags of ['&refetchLyrics=yes', '&refetchLyrics=true&refetchLyrics=false', '&analysisOnly=1', '&analysisOnly=true&refetchLyrics=true']) {
            assert.equal((await fetch(base + flags)).status, 400);
        }
        assert.equal(calls.length, 0);
        assert.equal((await fetch(base + '&refetchLyrics=true')).status, 200);
        assert.equal(calls[0].options.refetchLyrics, true); assert.equal(calls[0].options.analysisOnly, false);
        assert.equal((await fetch(base + '&analysisOnly=true')).status, 200);
        assert.equal(calls[1].options.refetchLyrics, false); assert.equal(calls[1].options.analysisOnly, true);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
