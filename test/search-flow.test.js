import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchSimilarSongs } from '../src/services/music.service.js';
import { resolveSearchInput } from '../src/services/artist.service.js';
import { resolveName } from '../src/services/search-normalization.js';
import { aiConfig } from '../src/ai/ai.config.js';

const names = ['Mindless Self Indulgence', 'Muse', 'Musa'].map(canonicalName => ({ canonicalName }));
const resolveInput = input => resolveSearchInput(input, { artistResolver: async value => ({ ...resolveName(value, names), available: true }) });
const origin = { found: true, confidence: .95, song: { title: 'Synthetic Source', artist: 'Mindless Self Indulgence', genre: 'Industrial Rock' } };
const recs = { recommendations: Array.from({ length: 11 }, (_, i) => ({ title: `Synthetic ${i}`, artist: 'Fixture Artist', reason: 'Fixture affinity' })) };
const input = { lyrics: 'Synthetic lyric fixture for identification', provider: 'gemini' };
const run = (body, values, prompts = []) => searchSimilarSongs({ ...input, ...body }, {
    resolveInput, acceptArtist: async () => ({ status: 'unchanged' }),
    callAI: async args => { prompts.push(JSON.parse(args.messages[1].content)); const value = values.shift(); if (value instanceof Error) throw value; return { provider: args.provider, model: 'fixture', content: JSON.stringify(value) }; },
});
test('exact and misspelled hints keep old contract, canonical corrections and recommendation genre', async () => {
    for (const artist of ['Mindless Self Indulgence', 'Mindles Self Indulgence', ' mindless  SELF indulgence ']) {
        const prompts = [];
        const result = await run({ artist, genre: 'symphonic mettal' }, [{ ...origin, song: { ...origin.song, genre: 'Symphonic Metal' } }, recs], prompts);
        assert.equal(result.count, 11);
        assert.equal(prompts[0].artist, 'Mindless Self Indulgence');
        assert.equal(prompts[0].genre, 'Symphonic Metal');
        assert.equal(prompts[1].optionalContext.genre, 'Symphonic Metal');
        assert.equal(result.input.original.artist, artist);
        assert.equal(result.input.corrections.at(-1).confidenceBand, 'high');
        assert.equal(result.song.catalogVerified, false);
        assert.equal(result.ai.callCount, 2);
    }
});
test('unresolved hints get relaxed then lyrics-only recovery without forcing a defective genre', async () => {
    const prompts = [];
    const result = await run({ artist: 'Wrong name', genre: 'Wrong style' }, [{ found: false }, { found: false }, origin, recs], prompts);
    assert.equal(result.found, true);
    assert.equal(prompts[1].artistFragment, 'Wrong name');
    assert.deepEqual([prompts[2].artist, prompts[2].genre, prompts[2].artistFragment], [null, null, undefined]);
    assert.equal(prompts[3].optionalContext.genre, 'Industrial Rock');
    assert.equal(result.ai.callCount, 4);
    assert.equal(result.ai.attempts[2].phase, 'identify_without_hints');
    const miss = await run({ artist: 'Wrong' }, [{ found: false }, { found: false }, { found: false }]);
    assert.equal(miss.found, false);
    assert.equal(miss.ai.callCount, 3);
    assert.deepEqual(miss.recommendations, []);
});
test('ambiguous artists suggest without silent replacement; rare genres and missing hints stay open', async () => {
    const result = await run({ artist: 'Musi', genre: 'Jazz / Post-Black Metal' }, [origin, recs]);
    assert.equal(result.input.resolved.artist, 'Musi');
    assert.equal(result.input.needsConfirmation, true);
    assert.equal(result.input.corrections.length, 2);
    assert.ok(result.input.corrections.every(c => !c.applied));
    const noHints = await run({}, [{ found: false }]);
    assert.deepEqual(noHints.input.resolved, { artist: null, genre: null });
    assert.equal(noHints.ai.callCount, 1);
});
test('provider failure during recovery is an error, never a musical miss', async () => {
    await assert.rejects(run({ artist: 'Wrong' }, [{ found: false }, new DOMException('fixture', 'TimeoutError')]), error => error.status === 502 && error.input.original.artist === 'Wrong');
});
test('a completely wrong but canonical genre cannot override the identified music style', async () => {
    const prompts = [];
    const result = await run({ genre: 'Jazz' }, [origin, recs], prompts);
    assert.equal(prompts[1].optionalContext.genre, 'Industrial Rock');
    assert.equal(result.input.resolved.genre, 'Jazz');
    assert.equal(result.ai.recommendationGenre, 'Industrial Rock');
});
test('global budget is five provider calls including fallback, one recovery and recommendation repair', async () => {
    const previous = { provider: aiConfig.provider, key: aiConfig.providers.deepseek.apiKey, fallback: process.env.MUSIC_ENABLE_FALLBACK };
    try {
        aiConfig.provider = 'gemini'; aiConfig.providers.deepseek.apiKey = 'test-fixture'; process.env.MUSIC_ENABLE_FALLBACK = 'true';
        const prompts = [];
        const result = await run({ provider: undefined, artist: 'Mindless Self Indulgence' }, [{ found: false }, { found: false }, origin, { recommendations: [] }, recs], prompts);
        assert.equal(prompts.length, 5);
        assert.equal(result.ai.callCount, 5);
        assert.deepEqual(result.ai.attempts.map(a => a.phase), ['identify', 'identify_without_hints', 'identify', 'recommend', 'recommend']);
        assert.ok(Number.isFinite(result.ai.totalElapsedMs));
    } finally {
        aiConfig.provider = previous.provider; aiConfig.providers.deepseek.apiKey = previous.key;
        if (previous.fallback === undefined) delete process.env.MUSIC_ENABLE_FALLBACK; else process.env.MUSIC_ENABLE_FALLBACK = previous.fallback;
    }
});
