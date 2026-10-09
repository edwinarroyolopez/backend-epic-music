import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createSongCache } from '../src/services/song-cache.service.js';
import { Song } from '../src/models/song.model.js';
import { lookupLyrics } from '../src/services/lyrics.service.js';
import { analyzeLyricsEmotions } from '../src/services/emotions.service.js';
import { createTransientLyricsStore } from '../src/services/transient-lyrics.store.js';
let mongo;
const input = { title: 'Own transient fixture', artist: 'Synthetic artist' };
const text = 'Own synthetic text for transient rendering and deterministic emotion analysis';
before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Song.init(); });
beforeEach(async () => { await Song.deleteMany({}); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
function fixture() {
    const counters = { externalLyricsCalls: 0, emotionAICalls: 0 };
    let failAI = false, currentText = text;
    const options = {
        lookup: (song, opts) => lookupLyrics(song, { ...opts, fetchImpl: async () => {
            counters.externalLyricsCalls++; await new Promise(r => setTimeout(r, 20));
            return Response.json({ id: 1, trackName: song.title, artistName: song.artist, plainLyrics: currentText });
        } }),
        analyze: (song, opts) => analyzeLyricsEmotions(song, { ...opts, callAI: async () => {
            counters.emotionAICalls++;
            if (failAI) throw new Error('Synthetic AI failure');
            return { provider: 'fixture', model: 'synthetic', content: JSON.stringify({ sufficientEvidence: true, emotions: [{ code: 'joy', score: 50 }, { code: 'hope', score: 30 }, { code: 'love', score: 20 }] }) };
        } }),
    };
    return { counters, options, fail: value => { failAI = value; }, changeText: value => { currentText = value; } };
}
test('default LRCLIB lookup returns visible text and emotions to20 viewers without storing text in Mongo', async t => {
    const { counters, options } = fixture(), cache = createSongCache(options);
    const values = await Promise.all(Array.from({ length: 20 }, () => cache(input)));
    assert.ok(values.every(v => v.status === 'available' && v.lyrics === text && v.lyricsStorage === 'transient' && v.emotionAnalysis.status === 'estimated'));
    assert.deepEqual(counters, { externalLyricsCalls: 1, emotionAICalls: 1 });
    const stored = await Song.findOne().lean();
    assert.equal(stored.lyrics.status, 'transient'); assert.equal(stored.lyrics.text, null);
    assert.equal(stored.lyrics.lookupAttempted, true); assert.ok(stored.lyrics.contentVersion);
    assert.equal(stored.emotionAnalysis.sourceContentVersion, stored.lyrics.contentVersion);
    assert.ok(!JSON.stringify(stored).includes(text));
    for (let i = 0; i < 5; i++) assert.equal((await cache(input)).lyrics, text);
    assert.deepEqual(counters, { externalLyricsCalls: 1, emotionAICalls: 1 });
    t.diagnostic(JSON.stringify(counters));
});
test('old LRCLIB rights_restricted records recover on ordinary opening without manual refetch or cooldown', async () => {
    const { counters, options } = fixture();
    const blocked = createSongCache({ ...options, transientPolicy: () => false });
    const previous = await blocked(input); assert.equal(previous.status, 'rights_restricted');
    const restored = await createSongCache(options)({ songId: previous.songId });
    assert.equal(restored.status, 'available'); assert.equal(restored.lyrics, text);
    assert.equal(restored.songId, previous.songId); assert.equal(await Song.countDocuments(), 1);
    assert.deepEqual(counters, { externalLyricsCalls: 2, emotionAICalls: 1 });
});
test('a new process cache needs text again but reuses the stored emotional analysis for the same hash', async () => {
    const { counters, options } = fixture();
    await createSongCache(options)(input);
    const afterRestart = await createSongCache(options)(input);
    assert.equal(afterRestart.lyrics, text); assert.equal(afterRestart.emotionAnalysis.status, 'estimated');
    assert.deepEqual(counters, { externalLyricsCalls: 2, emotionAICalls: 1 });
    assert.equal((await Song.findOne()).lyrics.text, null);
});
test('emotion retry uses transient text while in memory and never downloads it again', async () => {
    const { counters, options, fail } = fixture();
    let time = Date.now(); fail(true);
    const cache = createSongCache({ ...options, now: () => new Date(time), retryMs: 100 });
    const first = await cache(input);
    assert.equal(first.lyrics, text); assert.equal(first.emotionAnalysis.status, 'unavailable');
    time += 101; fail(false);
    const retry = await cache(input, { analysisOnly: true });
    assert.equal(retry.emotionAnalysis.status, 'estimated'); assert.equal(retry.lyrics, text);
    assert.deepEqual(counters, { externalLyricsCalls: 1, emotionAICalls: 2 });
});
test('bounded transient memory expires; same hash reuses AI and changed text invalidates it', async () => {
    const { counters, options, changeText } = fixture(); let time = Date.now();
    const cache = createSongCache({ ...options, now: () => new Date(time), transientTtlMs: 100 });
    const first = await cache(input); time += 101;
    const second = await cache(input);
    assert.equal(second.lyrics, text); assert.deepEqual(counters, { externalLyricsCalls: 2, emotionAICalls: 1 });
    time += 101; changeText('Different own synthetic text');
    const changed = await cache(input);
    assert.notEqual(changed.emotionAnalysis.sourceContentVersion, first.emotionAnalysis.sourceContentVersion);
    assert.deepEqual(counters, { externalLyricsCalls: 3, emotionAICalls: 2 });
    assert.equal((await Song.findOne()).lyrics.text, null);
    const store = createTransientLyricsStore({ maxEntries: 1, ttlMs: 20 });
    store.put('A', 'v1', 'own A'); store.put('B', 'v2', 'own B');
    assert.equal(store.get('A', 'v1'), null); assert.equal(store.get('B', 'wrong-version'), null);
    assert.equal(store.get('B', 'v2'), 'own B');
    await new Promise(r => setTimeout(r, 30)); assert.equal(store.get('B', 'v2'), null);
});
test('independent transient caches serialize acquisitions and share durable AI without pretending to share text', async t => {
    const { options, counters } = fixture();
    let active = 0, maximum = 0;
    const lookup = async (...args) => { active++; maximum = Math.max(maximum, active); try { return await options.lookup(...args); } finally { active--; } };
    const a = createSongCache({ ...options, lookup }), b = createSongCache({ ...options, lookup });
    const read = async cache => {
        for (let i = 0; i < 5; i++) {
            const data = await cache(input);
            if (data.status === 'available' && data.emotionAnalysis.status === 'estimated') return data;
            await new Promise(r => setTimeout(r, 20));
        }
        assert.fail('Shared result did not finish within bounded polling');
    };
    const data = await Promise.all(Array.from({ length: 20 }, (_, i) => read(i % 2 ? a : b)));
    assert.ok(data.every(d => d.lyrics === text)); assert.equal(maximum, 1);
    assert.deepEqual(counters, { externalLyricsCalls: 2, emotionAICalls: 1 });
    t.diagnostic(JSON.stringify({ ...counters, maxConcurrentLookups: maximum }));
});
