import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { Artist } from '../src/models/artist.model.js';
import { aiConfig } from '../src/ai/ai.config.js';
import { resolveName } from '../src/services/search-normalization.js';
import { resolveSearchInput, resolveArtist, acceptIdentifiedArtist } from '../src/services/artist.service.js';
import { searchSimilarSongs } from '../src/services/music.service.js';

const lyrics = 'Synthetic fragment for incomplete artist regression';
// Deterministic fixtures only: not a claim about a real song/provider response.
const identification = { found: true, confidence: .95, song: { title: 'Fixture source', artist: 'Miranda!', genre: 'Pop' } };
const recommendations = { recommendations: Array.from({ length: 11 }, (_, i) => ({ title: `Fixture ${i}`, artist: 'Fixture artist', genre: 'Pop', reason: 'Fixture comparison' })) };
const names = [{ canonicalName: 'Miranda!' }];
const response = (provider, data) => ({ provider, model: 'incomplete-artist-fixture', content: JSON.stringify(data) });
let mongo;
before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Artist.init(); });
after(async () => { await mongoose.disconnect(); await mongo?.stop(); });

test('unique substantial prefix resolves Mirand, while short/ambiguous/incomplete sets never autocomplete silently', () => {
    const unique = resolveName('Mirand', names);
    assert.equal(unique.value, 'Miranda!');
    assert.equal(unique.source, 'catalog_prefix');
    assert.equal(unique.recognized, true);
    assert.equal(resolveName('Mira', names).recognized, false);
    const ambiguous = resolveName('Mirand', [...names, { canonicalName: 'Miranda Lambert' }]);
    assert.equal(ambiguous.recognized, false);
    assert.deepEqual(ambiguous.candidates.sort(), ['Miranda Lambert', 'Miranda!'].sort());
    assert.equal(resolveName('Mirand', names, { complete: false }).recognized, false);
    assert.equal(resolveName('Mirand', [...names, { canonicalName: 'Mirant' }]).recognized, false);
    assert.equal(resolveName('Mirand', [...names, { canonicalName: 'Mirand' }]).value, 'Mirand');
});

test('successful canonical spelling can populate the global directory; next partial HTTP search sends canonical artist to DeepSeek', async () => {
    const prompts = [];
    const server = createApp({ search: body => searchSimilarSongs(body, { callAI: async ({ messages, provider }) => {
        const prompt = JSON.parse(messages[1].content); prompts.push(prompt);
        return response(provider, !prompt.lyrics ? recommendations : ['Miranda', 'Miranda!'].includes(prompt.artist) ? identification : { found: false });
    } }) }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const search = async artist => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/search-songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lyrics, artist, provider: 'deepseek' }) });
        return { status: res.status, ...(await res.json()) };
    };
    try {
        const full = await search('Miranda');
        assert.equal(full.status, 200); assert.equal(full.data.directory.status, 'saved');
        assert.equal(await Artist.countDocuments({ canonicalName: 'Miranda!' }), 1);
        const partial = await search('Mirand');
        assert.equal(partial.status, 200); assert.equal(partial.data.found, true); assert.equal(partial.data.count, 11);
        assert.equal(partial.data.input.resolved.artist, 'Miranda!');
        assert.equal(partial.data.input.corrections[0].source, 'catalog_prefix');
        assert.equal(prompts[2].artist, 'Miranda!');
        assert.equal(partial.data.ai.callCount, 2);
        const record = await Artist.findOne({ canonicalName: 'Miranda!' }).lean();
        assert.equal(record.validationStatus, 'model_inferred');
        assert.ok(!record.aliases.includes('Mirand'), 'A temporary prefix must not become an enduring alias');
        // A raw hint without an identified song is still not promoted.
        await acceptIdentifiedArtist(null, { originalArtist: 'Raw input only', resolution: { recognized: false } });
        assert.equal(await Artist.countDocuments({ canonicalName: 'Raw input only' }), 0);
        const uri = mongo.getUri(); await mongoose.disconnect(); await mongoose.connect(uri);
        assert.equal((await resolveArtist('Mirand')).value, 'Miranda!');
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('empty directory recovery keeps the partial name as an optional fragment instead of losing useful evidence', async () => {
    const prompts = [];
    const result = await searchSimilarSongs({ lyrics, artist: 'Mirand', provider: 'deepseek' }, {
        resolveInput: body => resolveSearchInput(body, { artistResolver: async value => ({ ...resolveName(value, []), available: true }) }),
        acceptArtist: async () => ({ status: 'unchanged' }),
        callAI: async ({ messages, provider }) => {
            const prompt = JSON.parse(messages[1].content); prompts.push(prompt);
            return response(provider, !prompt.lyrics ? recommendations : prompt.artistFragment === 'Mirand' ? identification : { found: false });
        },
    });
    assert.equal(result.found, true); assert.equal(result.count, 11);
    assert.equal(result.ai.attempts[1].phase, 'identify_relaxed_artist');
    assert.equal(prompts[1].artist, null); assert.equal(prompts[1].artistFragment, 'Mirand');
    assert.equal(result.input.resolved.artist, 'Mirand', 'No deterministic catalog correction may be invented');
    assert.deepEqual(result.input.corrections, []);
    assert.equal(result.song.catalogVerified, false);
    assert.equal(result.ai.callCount, 3);
});

test('completed DeepSeek misses survive a failed optional Gemini fallback; no fake songs or 502', async () => {
    const previous = { provider: aiConfig.provider, key: aiConfig.providers.gemini.apiKey, fallback: process.env.MUSIC_ENABLE_FALLBACK };
    try {
        aiConfig.provider = 'deepseek'; aiConfig.providers.gemini.apiKey = 'fixture-only'; process.env.MUSIC_ENABLE_FALLBACK = 'true';
        const calls = [];
        const result = await searchSimilarSongs({ lyrics, artist: 'Miranda!' }, {
            resolveInput: body => resolveSearchInput(body, { artistResolver: async value => ({ ...resolveName(value, names), available: true }) }),
            callAI: async ({ provider }) => { calls.push(provider); if (provider === 'gemini') throw new Error('private-fixture-detail'); return response(provider, { found: false }); },
        });
        assert.deepEqual(calls, ['deepseek', 'deepseek', 'gemini']);
        assert.equal(result.found, false); assert.equal(result.song, null); assert.deepEqual(result.recommendations, []);
        assert.equal(result.ai.attempts.at(-1).status, 'error');
        assert.ok(!JSON.stringify(result).includes('private-fixture-detail'));
    } finally {
        aiConfig.provider = previous.provider; aiConfig.providers.gemini.apiKey = previous.key;
        if (previous.fallback === undefined) delete process.env.MUSIC_ENABLE_FALLBACK; else process.env.MUSIC_ENABLE_FALLBACK = previous.fallback;
    }
});

test('unresolved partial misses exhaust at most three identification calls and then return an honest miss', async () => {
    const prompts = [];
    const result = await searchSimilarSongs({ lyrics, artist: 'Unknown fragment', provider: 'deepseek' }, {
        resolveInput: body => resolveSearchInput(body, { artistResolver: async value => ({ ...resolveName(value, []), available: false }) }),
        callAI: async ({ provider, messages }) => { prompts.push(JSON.parse(messages[1].content)); return response(provider, { found: false }); },
    });
    assert.equal(result.found, false);
    assert.equal(result.ai.callCount, 3);
    assert.deepEqual(result.ai.attempts.map(a => a.phase), ['identify', 'identify_relaxed_artist', 'identify_without_hints']);
    assert.deepEqual(prompts[2], { lyrics, artist: null, genre: null });
});

test('real DeepSeek failures and interrupted recovery remain 502, not successful misses', async () => {
    for (const values of [[new Error('fixture')], [{ found: false }, new DOMException('fixture', 'TimeoutError')],
        [{ found: false }, { found: false }, new Error('fixture')]]) {
        await assert.rejects(searchSimilarSongs({ lyrics, artist: 'Unknown fragment', provider: 'deepseek' }, {
            callAI: async ({ provider }) => { const value = values.shift(); if (value instanceof Error) throw value; return response(provider, value); },
        }), { status: 502 });
    }
});

test('malformed JSON adds exactly one failed attempt, keeping cost metrics and history within bounds', async () => {
    const previous = { provider: aiConfig.provider, key: aiConfig.providers.gemini.apiKey, fallback: process.env.MUSIC_ENABLE_FALLBACK };
    try {
        aiConfig.provider = 'deepseek'; aiConfig.providers.gemini.apiKey = 'fixture-only'; process.env.MUSIC_ENABLE_FALLBACK = 'true';
        let calls = 0;
        const result = await searchSimilarSongs({ lyrics }, {
            callAI: async ({ provider, messages }) => {
                calls++;
                if (provider === 'deepseek') return { provider, model: 'fixture', content: 'invalid JSON fixture' };
                return response(provider, JSON.parse(messages[1].content).lyrics ? identification : recommendations);
            },
        });
        assert.equal(calls, 3); assert.equal(result.ai.callCount, 3); assert.equal(result.ai.attempts.length, 3);
        assert.equal(result.ai.attempts[0].status, 'error');
    } finally {
        aiConfig.provider = previous.provider; aiConfig.providers.gemini.apiKey = previous.key;
        if (previous.fallback === undefined) delete process.env.MUSIC_ENABLE_FALLBACK; else process.env.MUSIC_ENABLE_FALLBACK = previous.fallback;
    }
});
