import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Song } from '../src/models/song.model.js';
import { resolveSong } from '../src/services/song-identity.service.js';
import { createSongCache as factory, claimSongWork, commitSongWork } from '../src/services/song-cache.service.js';
import { emptyEmotionAnalysis, analyzeLyricsEmotions } from '../src/services/emotions.service.js';
import { lookupLyrics } from '../src/services/lyrics.service.js';
let mongo;
const createSongCache = options => factory({ analyze: async () => emptyEmotionAnalysis('insufficient_evidence'), ...options });
const input = { title: 'Synthetic A', artist: 'Own fixture' };
const storagePolicy = data => ({ authorized: data.source.name === 'OWN_FIXTURE', reference: 'own synthetic test text, 2026-10-09' });
const result = song => ({ ...song, status: 'available', lyrics: 'Own synthetic line for cache tests', source: { name: 'OWN_FIXTURE' } });
before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Song.init(); });
beforeEach(async () => { await Song.deleteMany({}); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
test('20 viewers across two service instances acquire exactly one lookup; reopens and artist isolation', async t => {
    const metrics = { externalLyricsCalls: 0 };
    const options = { storagePolicy, metrics, lookup: async song => { metrics.externalLyricsCalls++; await new Promise(r => setTimeout(r, 60)); return result(song); } };
    const a = createSongCache(options), b = createSongCache(options);
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b)(input)));
    assert.ok(responses.every(r => r.status === 'available' && r.lookupAttempted));
    assert.equal(metrics.externalLyricsCalls, 1); assert.equal(metrics.concurrentClaimsWon, 2);
    for (let i = 0; i < 5; i++) assert.equal((await b({ songId: responses[0].songId })).lyrics, responses[0].lyrics);
    assert.equal(metrics.externalLyricsCalls, 1); assert.equal(await Song.countDocuments(), 1);
    t.diagnostic(JSON.stringify({ ...metrics, songDocumentsCount: await Song.countDocuments() }));
    await a({ ...input, artist: 'Another fixture' }); assert.equal(metrics.externalLyricsCalls, 2);
});
test('terminal negatives, restricted rights, and cancellation never duplicate lookup', async () => {
    for (const status of ['not_found', 'instrumental', 'available']) {
        let calls = 0;
        const cache = createSongCache({ lookup: async song => { calls++; return { ...result(song), status }; } });
        const song = { ...input, title: status };
        const controller = new AbortController(); controller.abort();
        const first = await cache(song, { signal: controller.signal });
        assert.equal(first.status, status === 'available' ? 'rights_restricted' : status);
        assert.equal(first.lyrics, null); assert.equal(first.lookupAttempted, true);
        await cache(song); assert.equal(calls, 1);
        assert.equal((await Song.findById(first.songId)).lyrics.text, null);
    }
});
test('transient failure persists cooldown and recovers; mismatched artist cannot be attached', async () => {
    let time = Date.now(), calls = 0;
    const cache = createSongCache({ storagePolicy, now: () => new Date(time), retryMs: 100,
        lookup: async song => { if (++calls === 1) throw Object.assign(new Error(), { retryAfterMs: 500 }); return result(song); } });
    assert.equal((await cache(input)).status, 'temporary_error');
    assert.equal((await cache(input)).status, 'temporary_error'); assert.equal(calls, 1);
    time += 501; assert.equal((await cache(input)).status, 'available'); assert.equal(calls, 2);
    const wrong = createSongCache({ storagePolicy, lookup: async song => result({ ...song, artist: 'Wrong' }) });
    assert.equal((await wrong({ ...input, title: 'Mismatch' })).status, 'temporary_error');
    assert.equal((await Song.findOne({ title: 'Mismatch' })).lyrics.text, null);
});
test('expired worker is fenced after another worker recovers its lease', async t => {
    const doc = await resolveSong(input), metrics = {};
    const old = await claimSongWork(Song, doc, 'lyrics', { now: new Date(0), leaseMs: 100, metrics });
    const cache = createSongCache({ storagePolicy, metrics, lookup: async song => result(song) });
    assert.equal((await cache(input)).status, 'available');
    assert.equal(await commitSongWork(Song, old, 'lyrics', { 'lyrics.status': 'not_found', 'lyrics.completedAt': new Date() }, metrics), false);
    assert.equal((await Song.findById(doc._id)).lyrics.status, 'available');
    assert.equal(metrics.staleWriteRejected, 1); t.diagnostic(JSON.stringify(metrics));
});
test('LRCLIB 429 Retry-After is retained as retry metadata', async () => {
    await assert.rejects(lookupLyrics(input, { fetchImpl: async () => new Response(null, { status: 429, headers: { 'Retry-After': '90' } }) }), error => error.retryAfterMs === 90000);
});
test('20 concurrent requests call actual emotion AI double once; version change and failed analysis retry never download lyrics', async t => {
    const metrics = { externalLyricsCalls: 0, emotionAICalls: 0 };
    let failure = false, time = Date.now();
    const options = { storagePolicy, metrics, now: () => new Date(time), retryMs: 100,
        lookup: async song => { metrics.externalLyricsCalls++; return result(song); },
        analyze: (song, opts) => analyzeLyricsEmotions(song, { ...opts, callAI: async () => {
            metrics.emotionAICalls++; await new Promise(r => setTimeout(r, 40));
            if (failure) throw new Error('Synthetic failure');
            return { provider: 'fixture', model: 'deterministic', content: JSON.stringify({ sufficientEvidence: true, emotions: [{ code: 'joy', score: 50 }, { code: 'hope', score: 30 }, { code: 'love', score: 20 }] }) };
        } }) };
    const a = createSongCache(options), b = createSongCache(options);
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b)(input)));
    assert.ok(responses.every(r => r.emotionAnalysis.status === 'estimated' && r.emotions.reduce((s, e) => s + e.score, 0) === 100));
    assert.equal(metrics.externalLyricsCalls, 1); assert.equal(metrics.emotionAICalls, 1);
    assert.equal(metrics.concurrentClaimsWon, 2);
    for (let i = 0; i < 5; i++) await b({ songId: responses[0].songId });
    assert.equal(metrics.emotionAICalls, 1);
    t.diagnostic(JSON.stringify({ ...metrics, songDocumentsCount: await Song.countDocuments() }));
    failure = true;
    const nextVersion = createSongCache({ ...options, analysisVersion: '2' });
    const failed = await nextVersion(input);
    assert.equal(failed.status, 'available'); assert.equal(failed.emotionAnalysis.status, 'unavailable');
    assert.equal(metrics.externalLyricsCalls, 1); assert.equal(metrics.emotionAICalls, 2);
    await nextVersion(input, { analysisOnly: true }); assert.equal(metrics.emotionAICalls, 2);
    failure = false; time += 101;
    assert.equal((await nextVersion(input, { analysisOnly: true })).emotionAnalysis.status, 'estimated');
    assert.equal(metrics.externalLyricsCalls, 1); assert.equal(metrics.emotionAICalls, 3);
    await nextVersion(input); assert.equal(metrics.emotionAICalls, 3);
});
test('insufficient evidence is final for content/algorithm version; analysis-only cannot start lookup', async () => {
    let lyricsCalls = 0, aiCalls = 0;
    const cache = createSongCache({ storagePolicy, lookup: async song => { lyricsCalls++; return result(song); },
        analyze: async () => { aiCalls++; return emptyEmotionAnalysis('insufficient_evidence'); } });
    const first = await cache(input, { analysisOnly: true }); assert.equal(first.status, 'never_attempted'); assert.equal(lyricsCalls, 0);
    await cache(input); await cache(input, { analysisOnly: true }); await cache(input);
    assert.equal(aiCalls, 1); assert.equal(lyricsCalls, 1);
});
test('manual refetch recovers a cached miss once across 20 requests, runs emotions, and never redownloads valid text', async t => {
    let time = Date.now(), found = false;
    const metrics = { externalLyricsCalls: 0, emotionAICalls: 0 };
    const options = { storagePolicy, metrics, now: () => new Date(time), retryMs: 100,
        lookup: async song => { metrics.externalLyricsCalls++; await new Promise(r => setTimeout(r, 30)); return { ...result(song), status: found ? 'available' : 'not_found' }; },
        analyze: (song, opts) => analyzeLyricsEmotions(song, { ...opts, callAI: async () => {
            metrics.emotionAICalls++;
            return { content: JSON.stringify({ sufficientEvidence: true, emotions: [{ code: 'joy', score: 50 }, { code: 'hope', score: 30 }, { code: 'love', score: 20 }] }) };
        } }) };
    const a = createSongCache(options), b = createSongCache(options);
    const miss = await a(input);
    assert.equal(miss.status, 'not_found'); assert.equal(new Date(miss.lyricsRefetchAt).getTime(), time + 100);
    await b(input, { refetchLyrics: true }); assert.equal(metrics.externalLyricsCalls, 1);
    time += 101; found = true;
    await a(input); assert.equal(metrics.externalLyricsCalls, 1); // Opening is not a refetch.
    const recovered = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b)(input, { refetchLyrics: true })));
    assert.ok(recovered.every(d => d.status === 'available' && d.emotionAnalysis.status === 'estimated'));
    assert.equal(metrics.externalLyricsCalls, 2); assert.equal(metrics.emotionAICalls, 1);
    time += 1000; await b(input, { refetchLyrics: true });
    assert.equal(metrics.externalLyricsCalls, 2); assert.equal(metrics.emotionAICalls, 1);
    assert.equal(await Song.countDocuments(), 1);
    t.diagnostic(JSON.stringify(metrics));
});
test('manual refetch attempts only once when still missing and does not bypass rights', async () => {
    let time = Date.now(), calls = 0, ai = 0, authorized = false;
    const missing = createSongCache({ retryMs: 0, lookup: async song => { calls++; return { ...result(song), status: 'not_found' }; } });
    await missing(input); await missing(input, { refetchLyrics: true }); assert.equal(calls, 2);
    const restrictedInput = { ...input, title: 'Restricted own fixture' };
    const cache = createSongCache({ retryMs: 100, now: () => new Date(time),
        storagePolicy: () => ({ authorized, reference: 'Own test text grant' }),
        lookup: async song => { calls++; return result(song); },
        analyze: async () => { ai++; return emptyEmotionAnalysis('insufficient_evidence'); } });
    assert.equal((await cache(restrictedInput)).status, 'rights_restricted');
    time += 101;
    const checked = await cache(restrictedInput, { refetchLyrics: true });
    assert.equal(calls, 4); assert.equal(checked.status, 'rights_restricted'); assert.equal(checked.lyrics, null); assert.equal(ai, 0);
    await cache(restrictedInput); assert.equal(calls, 4);
    authorized = true; time += 101;
    assert.equal((await cache(restrictedInput, { refetchLyrics: true })).status, 'available');
    assert.equal(calls, 5); assert.equal(ai, 1);
});
test('refetch handles never-attempted and transient results without retry loops or resetting emotional success', async () => {
    let calls = 0;
    const cache = createSongCache({ retryMs: 0, lookup: async () => { calls++; throw new Error('Synthetic failure'); } });
    assert.equal((await cache(input, { analysisOnly: true })).lookupAttempted, false);
    assert.equal((await cache(input, { refetchLyrics: true })).status, 'temporary_error'); assert.equal(calls, 1);
    assert.equal((await cache(input, { refetchLyrics: true })).status, 'temporary_error'); assert.equal(calls, 2);
    await assert.rejects(cache(input, { analysisOnly: true, refetchLyrics: true }), { code: 'VALIDATION_ERROR' });
});
