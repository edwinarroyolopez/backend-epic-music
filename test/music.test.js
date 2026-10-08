import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { searchSimilarSongs } from '../src/services/music.service.js';
import { aiConfig } from '../src/ai/ai.config.js';

const input = { lyrics: 'Synthetic fragment for deterministic testing', provider: 'gemini' };
const identified = { found: true, confidence: .9, song: { title: 'Source', artist: 'Artist' } };
const recommendations = Array.from({ length: 11 }, (_, i) => ({ title: `Song ${i}`, artist: 'Other', reason: 'Instrumentation' }));
const mock = (values, calls = []) => async (args) => {
    calls.push(args.provider);
    const value = values.shift();
    if (value instanceof Error) throw value;
    return { provider: args.provider, model: 'test-only', content: typeof value === 'string' ? value : JSON.stringify(value) };
};

test('identified + 11 unique unverified songs; explicit provider respected', async () => {
    const calls = [];
    const result = await searchSimilarSongs(input, { callAI: mock([identified, { recommendations }], calls) });
    assert.equal(result.count, 11);
    assert.equal(result.song.title, 'Source');
    assert.equal(result.song.artist, 'Artist');
    assert.equal(result.song.catalogVerified, false);
    assert.ok(result.recommendations.every(s => s.catalogVerified === false));
    assert.deepEqual(calls, ['gemini', 'gemini']);
});

test('found:false and low confidence contain no invented songs', async () => {
    for (const value of [{ found: false }, { ...identified, confidence: .3 }]) {
        const result = await searchSimilarSongs(input, { callAI: mock([value]) });
        assert.equal(result.found, false);
        assert.equal(result.song, null);
        assert.deepEqual(result.recommendations, []);
    }
});

test('malformed identification, JSON, provider error and timeout are 502, not misses', async () => {
    for (const value of [{ bad: true }, { found: true, confidence: .9, song: {} }, 'not JSON', new Error('private-provider-detail'), new DOMException('timeout', 'TimeoutError')]) {
        const calls = [];
        await assert.rejects(searchSimilarSongs(input, { callAI: mock([value], calls) }), { status: 502 });
        assert.deepEqual(calls, ['gemini']);
    }
});

test('duplicates and incomplete recommendations rejected after exactly two attempts', async () => {
    for (const invalid of [[...recommendations.slice(1), recommendations[1]], recommendations.slice(1), [{ ...identified.song, reason: 'x' }, ...recommendations.slice(1)]]) {
        const calls = [];
        await assert.rejects(searchSimilarSongs(input, { callAI: mock([identified, { recommendations: invalid }, { recommendations: invalid }], calls) }), { status: 502 });
        assert.equal(calls.length, 3);
    }
});

test('configured fallback is respected; disabled fallback and explicit provider never switch', async () => {
    const previous = { provider: aiConfig.provider, key: aiConfig.providers.deepseek.apiKey, fallback: process.env.MUSIC_ENABLE_FALLBACK };
    try {
        aiConfig.provider = 'gemini';
        aiConfig.providers.deepseek.apiKey = 'test-only-placeholder';
        process.env.MUSIC_ENABLE_FALLBACK = 'true';
        const calls = [];
        const result = await searchSimilarSongs({ lyrics: input.lyrics }, { callAI: mock([new Error('provider failure'), identified, { recommendations }], calls) });
        assert.equal(result.found, true);
        assert.deepEqual(calls, ['gemini', 'deepseek', 'deepseek']);
        process.env.MUSIC_ENABLE_FALLBACK = 'false';
        const disabled = [];
        await assert.rejects(searchSimilarSongs({ lyrics: input.lyrics }, { callAI: mock([new Error('failure')], disabled) }), { status: 502 });
        assert.deepEqual(disabled, ['gemini']);
        const explicit = [];
        await searchSimilarSongs({ ...input, provider: 'deepseek' }, { callAI: mock([identified, { recommendations }], explicit) });
        assert.deepEqual(explicit, ['deepseek', 'deepseek']);
    } finally {
        aiConfig.provider = previous.provider;
        aiConfig.providers.deepseek.apiKey = previous.key;
        if (previous.fallback === undefined) delete process.env.MUSIC_ENABLE_FALLBACK;
        else process.env.MUSIC_ENABLE_FALLBACK = previous.fallback;
    }
});

test('HTTP contract, limits, malformed JSON and public access', async () => {
    let calls = 0;
    const server = createApp({ search: async body => { calls++; assert.equal(body.lyrics, input.lyrics); return { found: false, song: null, recommendations: [], count: 0 }; } }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const url = `http://127.0.0.1:${server.address().port}/search-songs`;
        for (const body of [{}, { lyrics: 'short' }, { ...input, lyrics: 'x'.repeat(12001) }, { ...input, artist: 'x'.repeat(201) }, { ...input, provider: 'unknown' }]) {
            assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
        }
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).data.found, false);
        assert.equal(calls, 1);
        assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
