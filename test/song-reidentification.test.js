import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchFragment, reidentifySong, searchLyricCandidates } from '../src/services/song-reidentification.service.js';
import { createApp } from '../src/app.js';
import { createReidentifyController } from '../src/controllers/reidentify.controller.js';
import { HistoryError } from '../src/services/search-history.service.js';
import { EventEmitter } from 'node:events';

const lyrics = 'Distinctive synthetic words drift across the river';
const record = { trackName: 'Published title', artistName: 'Fixture artist', plainLyrics: `Opening line\n${lyrics}\nClosing line` };
test('fragment evidence ignores case/accents/punctuation, deduplicates albums and rejects ambiguity and partial words', () => {
    assert.equal(matchFragment('Dístinctive SYNTHETIC words, drift\nacross the river', [record, { ...record, albumName: 'Compilation' }]).length, 1);
    assert.equal(matchFragment(lyrics, [record, { ...record, trackName: 'Another song' }]).length, 2);
    assert.equal(matchFragment(lyrics, [{ ...record, plainLyrics: 'Unrelated lyrics' }]).length, 0);
    assert.equal(matchFragment(lyrics, [{ ...record, instrumental: true }]).length, 0);
    assert.equal(matchFragment('words drift across the rive', [record]).length, 0);
    assert.equal(matchFragment('Distinctive synthetic words', [record]).length, 0);
});
test('artist catalog corrects a hallucinated title without AI and returns metadata only', async () => {
    const data = await reidentifySong({ lyrics, previous: { title: 'Distinctive synthetic words', artist: record.artistName } }, {
        search: async input => { assert.deepEqual(input, { artist: record.artistName }); return [record]; },
        callAI: () => assert.fail('Catalog already matched; no AI needed'),
    });
    assert.equal(data.song.title, 'Published title'); assert.equal(data.song.catalogVerified, true);
    assert.equal(data.verification, 'lyrics_match');
    assert.ok(!JSON.stringify(data).includes(lyrics)); assert.equal(data.song.songId, undefined);
});
test('AI candidates must match catalog lyrics; fabricated suggestions never replace the source', async () => {
    const input = { lyrics, artist: 'Wrong hint', previous: { title: 'Wrong title', artist: 'Wrong artist' } };
    let calls = 0;
    const dependencies = {
        search: async query => { calls++; return query.title === record.trackName ? [record] : []; },
        callAI: async ({ messages }) => { assert.equal(JSON.parse(messages[1].content).lyrics, lyrics); return { content: JSON.stringify({ candidates: [{ title: record.trackName, artist: record.artistName }] }) }; },
    };
    assert.equal((await reidentifySong(input, dependencies)).song.title, record.trackName);
    assert.equal(calls, 2);
    assert.deepEqual(await reidentifySong(input, { ...dependencies, search: async () => [] }), { found: false, song: null, reason: 'unconfirmed' });
    const ambiguous = await reidentifySong(input, { ...dependencies, search: async () => [record, { ...record, artistName: 'Cover artist' }] });
    assert.equal(ambiguous.reason, 'ambiguous'); assert.equal(ambiguous.song, null);
    await assert.rejects(reidentifySong(input, { search: async () => { throw Error(); }, callAI: async () => { throw Error(); } }), { code: 'PROVIDER_ERROR' });
});
test('catalog search sends only metadata to fixed origin, bounds response and handles malformed payloads', async () => {
    const result = await searchLyricCandidates({ artist: 'Artist & name', title: 'Title ?' }, { fetchImpl: async (url, options) => {
        assert.equal(url.origin, 'https://lrclib.net'); assert.equal(url.searchParams.get('artist_name'), 'Artist & name');
        assert.equal(url.searchParams.get('track_name'), 'Title ?'); assert.equal(options.redirect, 'error');
        return Response.json([record]);
    } });
    assert.equal(result.length, 1);
    for (const response of [Response.json({}), new Response(null, { status: 503 }), new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
        await assert.rejects(searchLyricCandidates({ artist: 'Fixture' }, { fetchImpl: async () => response }));
    }
});
test('public correction validates input, enforces history ownership before work, and does not cache responses', async () => {
    let calls = 0;
    const server = createApp({ isReady: () => false, reidentify: { identify: async () => { calls++; return { found: true, song: { title: record.trackName, artist: record.artistName }, verification: 'lyrics_match' }; } } }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const post = body => fetch(`http://127.0.0.1:${server.address().port}/reidentify-song`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
        for (const body of [{ lyrics: 'short' }, { lyrics, artist: {} }, { lyrics, previous: { title: 'x' } }, { lyrics: 'x'.repeat(12001) }]) assert.equal((await post(body)).status, 400);
        assert.equal((await post({ lyrics, historyId: 'a'.repeat(24) })).status, 401); assert.equal(calls, 0);
        const response = await post({ lyrics });
        assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await response.json()).data.song.title, record.trackName); assert.equal(calls, 1);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
test('owned correction persists only the new song identity; foreign history and failed saves are explicit', async () => {
    let identified = 0, saved = 0;
    const handler = createReidentifyController({
        owned: async (owner, id) => { assert.equal(owner, 'owner'); if (id === 'foreign') throw new HistoryError('NOT_FOUND', 404); return { status: 'found' }; },
        identify: async () => { identified++; return { found: true, song: { title: record.trackName, artist: record.artistName }, verification: 'lyrics_match' }; },
        attach: async songs => songs.map(song => ({ ...song, songId: 'b'.repeat(24) })),
        replace: async (_owner, id, song) => { saved++; assert.equal(song.songId, 'b'.repeat(24)); assert.equal(song.lyrics, undefined); if (id === 'failure') throw Error(); },
    });
    const invoke = async historyId => {
        const res = new EventEmitter(); res.set = () => res; res.status = value => { res.code = value; return res; }; res.json = value => { res.body = value; return res; };
        await handler({ body: { lyrics, historyId, previous: { title: 'Wrong', artist: 'Fixture', songId: 'a'.repeat(24) } }, historyOwner: 'owner', app: { locals: { isReady: () => true } } }, res);
        return res;
    };
    assert.equal((await invoke('foreign')).code, 404); assert.equal(identified, 0);
    assert.equal((await invoke('owned')).body.data.history.status, 'saved');
    assert.equal((await invoke('failure')).body.data.history.status, 'unavailable'); assert.equal(saved, 2);
});
