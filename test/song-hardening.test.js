import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Song } from '../src/models/song.model.js';
import { createApp } from '../src/app.js';
import { createSongCache, claimSongWork, commitSongWork } from '../src/services/song-cache.service.js';
import { emptyEmotionAnalysis } from '../src/services/emotions.service.js';
let mongo;
const input = { title: 'Hardening own fixture', artist: 'Fixture' };
const storagePolicy = () => ({ authorized: true, reference: 'Own hardening synthetic text' });
const analyze = async () => emptyEmotionAnalysis('insufficient_evidence');
const result = song => ({ ...song, status: 'available', lyrics: 'Own synthetic line', source: { name: 'OWN_FIXTURE' } });
before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Song.init(); });
beforeEach(async () => { await Song.deleteMany({}); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
test('two real Node processes, 20 requests, one external lookup and one emotion AI call, restart reads Mongo', async t => {
    const workers = Array.from({ length: 2 }, () => fork(new URL('./fixtures/song-cache-worker.mjs', import.meta.url), [mongo.getUri()], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
    try {
        await Promise.all(workers.map(w => once(w, 'message')));
        const done = workers.map(w => once(w, 'message'));
        const exits = workers.map(w => once(w, 'exit'));
        workers.forEach(w => w.send({ input }));
        const responses = (await Promise.all(done)).map(([message]) => message);
        assert.ok(responses.every(r => !r.error && r.statuses.every(s => s === 'estimated')));
        assert.equal(new Set(responses.flatMap(r => r.ids)).size, 1);
        const totals = responses.reduce((sum, r) => {
            for (const [key, count] of Object.entries(r.metrics)) sum[key] = (sum[key] || 0) + count;
            return sum;
        }, {});
        assert.equal(totals.externalLyricsCalls, 1); assert.equal(totals.emotionAICalls, 1); assert.equal(totals.concurrentClaimsWon, 2);
        assert.equal(await Song.countDocuments(), 1);
        assert.ok((await Promise.all(exits)).every(([code]) => code === 0));
        const reopened = await createSongCache({ lookup: () => assert.fail('lookup on reopen'), analyze: () => assert.fail('AI on reopen') })(input);
        assert.equal(reopened.emotionAnalysis.status, 'estimated');
        t.diagnostic(JSON.stringify({ ...totals, songDocumentsCount: await Song.countDocuments() }));
    } finally { workers.forEach(w => { if (w.exitCode == null) w.kill(); }); }
});
test('bounded 202 HTTP, cancelled winning viewer, shared commit, privacy-safe DTO', async () => {
    let calls = 0, started;
    const ready = new Promise(r => { started = r; });
    const cache = createSongCache({ storagePolicy, analyze, waitMs: 5, pollMs: 2, lookup: async song => { calls++; started(); await new Promise(r => setTimeout(r, 150)); return result(song); } });
    const server = createApp({ lyrics: cache }).listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
        const url = `http://127.0.0.1:${server.address().port}/songs/lyrics?${new URLSearchParams(input)}`;
        const controller = new AbortController();
        const cancelled = fetch(url, { signal: controller.signal });
        await ready; controller.abort(); await assert.rejects(cancelled, { name: 'AbortError' });
        const waiting = await fetch(url); assert.equal(waiting.status, 202); assert.equal(waiting.headers.get('retry-after'), '1');
        const pending = await waiting.json(); assert.equal(pending.data.lookupAttempted, true);
        assert.ok(!JSON.stringify(pending).includes('token')); assert.ok(!JSON.stringify(pending).includes('lease'));
        await new Promise(r => setTimeout(r, 200));
        const completed = await (await fetch(url)).json(); assert.equal(completed.data.status, 'available'); assert.equal(calls, 1);
        assert.equal((await Song.findOne()).lyrics.status, 'available');
    } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
test('missing Mongo or UNIQUE index returns honest error without external provider', async () => {
    let calls = 0;
    const cache = createSongCache({ lookup: () => { calls++; throw new Error(); } });
    await Song.collection.dropIndex('canonicalKey_1');
    await assert.rejects(cache(input), { code: 'SONG_CACHE_UNAVAILABLE' }); assert.equal(calls, 0);
    await Song.createIndexes(); await mongoose.disconnect();
    await assert.rejects(cache(input), { code: 'SONG_CACHE_UNAVAILABLE' }); assert.equal(calls, 0);
    const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/songs/lyrics?${new URLSearchParams(input)}`);
        assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'SONG_CACHE_UNAVAILABLE');
    } finally { await new Promise(r => server.close(r)); await mongoose.connect(mongo.getUri()); }
});
test('orphan analysis recovers, stale analysis cannot overwrite; only content change invalidates final evidence', async () => {
    let calls = 0;
    const cache = createSongCache({ storagePolicy, lookup: async song => result(song), analyze: async () => { calls++; return analyze(); } });
    const first = await cache(input); const doc = await Song.findById(first.songId).lean();
    const old = await claimSongWork(Song, doc, 'emotionAnalysis', { now: new Date(0), leaseMs: 10 });
    const recovered = await cache(input); assert.equal(recovered.emotionAnalysis.status, 'insufficient_evidence'); assert.equal(calls, 2);
    const metrics = {};
    assert.equal(await commitSongWork(Song, old, 'emotionAnalysis', { 'emotionAnalysis.status': 'unavailable' }, metrics), false);
    assert.equal(metrics.staleWriteRejected, 1);
    await Song.updateOne({ _id: doc._id }, { $set: { 'lyrics.contentVersion': 'authorized-new-version', 'lyrics.text': 'New own synthetic text', 'emotionAnalysis.status': 'not_started' } });
    const updated = await cache(input); assert.equal(updated.emotionAnalysis.sourceContentVersion, 'authorized-new-version'); assert.equal(calls, 3);
    await cache(input); assert.equal(calls, 3);
});
test('provider ignoring abort cannot leave infinite progress or commit late', async () => {
    const cache = createSongCache({ storagePolicy, analyze, workMs: 10, leaseMs: 30,
        lookup: async song => { await new Promise(r => setTimeout(r, 60)); return result(song); } });
    assert.equal((await cache(input)).status, 'temporary_error');
    await new Promise(r => setTimeout(r, 100));
    const doc = await Song.findOne(); assert.equal(doc.lyrics.text, null); assert.equal(doc.lyrics.status, 'temporary_error');
});
test('twenty retries after cooldown elect one new lookup; edition mismatch stays provisional without text', async () => {
    let calls = 0, time = Date.now();
    const cache = createSongCache({ storagePolicy, analyze, now: () => new Date(time), retryMs: 100,
        lookup: async song => { calls++; await new Promise(r => setTimeout(r, 30)); if (calls === 1) throw new Error('Synthetic failure'); return result(song); } });
    assert.equal((await cache(input)).status, 'temporary_error');
    await Promise.all(Array.from({ length: 20 }, () => cache(input))); assert.equal(calls, 1);
    time += 101;
    const recovered = await Promise.all(Array.from({ length: 20 }, () => cache(input)));
    assert.ok(recovered.every(r => r.status === 'available')); assert.equal(calls, 2);
    const mismatch = createSongCache({ storagePolicy, analyze, lookup: async song => result({ ...song, edition: '' }) });
    const other = await mismatch({ ...input, edition: 'live' });
    assert.equal(other.status, 'temporary_error'); assert.equal(other.lyrics, null); assert.equal(other.catalogVerified, false);
    assert.equal(await Song.countDocuments(), 2);
});
