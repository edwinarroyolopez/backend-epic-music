import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLyricsEmotions } from '../src/services/emotions.service.js';
import { getLyricsWithEmotions, lookupLyrics } from '../src/services/lyrics.service.js';
import { DeepSeekProvider } from '../src/ai/providers/deepseek.provider.js';
import { GeminiProvider } from '../src/ai/providers/gemini.provider.js';
import { createApp } from '../src/app.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const input = { title: 'Synthetic recommendation', artist: 'Fixture artist', lyrics: 'Synthetic lyrics about longing and hope' };
const values = { sufficientEvidence: true, emotions: [{ code: 'love', score: 20 }, { code: 'sadness', score: 50 }, { code: 'nostalgia', score: 30 }] };
const mock = data => async () => ({ provider: 'fixture', model: 'fixture-model', content: typeof data === 'string' ? data : JSON.stringify(data) });

test('top-three emotions are validated, sorted relative metrics with one bounded AI call', async () => {
    let calls = 0;
    const result = await analyzeLyricsEmotions(input, { callAI: async args => {
        calls++;
        assert.equal(args.maxTokens, 500); assert.equal(args.timeoutMs, 10000); assert.equal(args.temperature, .1);
        assert.equal(JSON.parse(args.messages[1].content).lyrics, input.lyrics);
        assert.ok(args.signal); return mock(values)();
    } });
    assert.equal(calls, 1); assert.equal(result.emotionAnalysis.status, 'estimated');
    assert.deepEqual(result.emotions.map(value => value.code), ['sadness', 'nostalgia', 'love']);
    assert.equal(result.emotions.reduce((sum, value) => sum + value.score, 0), 100);
    assert.equal(result.emotionAnalysis.scope, 'lyrics'); assert.equal(result.emotionAnalysis.callCount, 1);
    assert.equal(result.emotionAnalysis.sampled, false); assert.ok(result.emotionAnalysis.elapsedMs >= 0);
    assert.ok(!JSON.stringify(result).includes(input.lyrics));
});
test('invalid/duplicate/unsupported emotions never produce fabricated metric values', async () => {
    for (const data of ['not JSON', null, {}, { ...values, emotions: values.emotions.slice(0, 2) },
        { ...values, emotions: [{ code: 'love', score: 20 }, { code: 'love', score: 50 }, { code: 'fear', score: 30 }] },
        { ...values, emotions: [{ code: 'unknown', score: 20 }, ...values.emotions.slice(1)] },
        { ...values, emotions: values.emotions.map(value => ({ ...value, score: 20 })) },
        { ...values, emotions: [{ code: 'love', score: 20.5 }, ...values.emotions.slice(1)] }]) {
        const result = await analyzeLyricsEmotions(input, { callAI: mock(data) });
        assert.equal(result.emotionAnalysis.status, 'unavailable'); assert.deepEqual(result.emotions, []);
    }
    const insufficient = await analyzeLyricsEmotions(input, { callAI: mock({ sufficientEvidence: false, emotions: [] }) });
    assert.equal(insufficient.emotionAnalysis.status, 'insufficient_evidence'); assert.deepEqual(insufficient.emotions, []);
});
const stalled = ({ signal }) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture guard')), 1000);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
});
test('emotion failure/timeout keeps metrics unavailable; caller cancellation stops the analysis', async () => {
    const timed = await analyzeLyricsEmotions(input, { callAI: stalled, timeoutMs: 5 });
    assert.equal(timed.emotionAnalysis.status, 'unavailable'); assert.deepEqual(timed.emotions, []);
    const controller = new AbortController();
    const pending = analyzeLyricsEmotions(input, { callAI: stalled, signal: controller.signal }); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    const failure = await analyzeLyricsEmotions(input, { callAI: async () => { throw new Error('private-fixture-detail'); } });
    assert.ok(!JSON.stringify(failure).includes('private-fixture-detail'));
});
test('large lyrics use a bounded beginning/end sample, while no lyrics do not call AI', async () => {
    let observed;
    const long = `FIRST ${'synthetic '.repeat(4000)} LAST`;
    const result = await analyzeLyricsEmotions({ ...input, lyrics: long }, { callAI: async args => {
        observed = JSON.parse(args.messages[1].content).lyrics; return mock(values)();
    } });
    assert.equal(result.emotionAnalysis.sampled, true); assert.ok(observed.length <= 12000);
    assert.ok(observed.startsWith('FIRST')); assert.ok(observed.endsWith('LAST'));
    const empty = await analyzeLyricsEmotions({ ...input, lyrics: '' }, { callAI: async () => assert.fail('No AI without lyrics') });
    assert.equal(empty.emotionAnalysis.callCount, 0); assert.equal(empty.emotionAnalysis.status, 'not_applicable');
});
test('one public request returns the selected lyrics and three emotions; missing analysis never discards lyrics', async () => {
    let calls = 0;
    const server = createApp({ lyrics: (song, options) => getLyricsWithEmotions(song, { ...options,
        lookup: (metadata, opts) => lookupLyrics(metadata, { ...opts, fetchImpl: async () => metadata.title === 'Missing' ? new Response(null, { status: 404 }) :
            Response.json({ trackName: metadata.title, artistName: metadata.artist, plainLyrics: `Synthetic lyrics for ${metadata.title}` }) }),
        analyze: (metadata, opts) => analyzeLyricsEmotions(metadata, { ...opts, callAI: async () => {
            calls++; if (metadata.title === 'Analysis fails') throw new Error('fixture'); return mock(values)();
        } }),
    }) }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        for (const title of ['First recommendation', 'Second recommendation', 'Analysis fails', 'Missing']) {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/songs/lyrics?${new URLSearchParams({ title, artist: 'Fixture artist' })}`);
            assert.equal(response.status, 200);
            const { data } = await response.json();
            assert.equal(data.title, title);
            if (title === 'Missing') { assert.equal(data.lyrics, null); assert.equal(data.emotionAnalysis.status, 'not_applicable'); }
            else {
                assert.equal(data.lyrics, `Synthetic lyrics for ${title}`);
                assert.equal(data.emotions.length, title === 'Analysis fails' ? 0 : 3);
                assert.equal(data.emotionAnalysis.status, title === 'Analysis fails' ? 'unavailable' : 'estimated');
            }
        }
        assert.equal(calls, 3);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
test('both provider transports respect auxiliary timeout and client cancellation', async () => {
    globalThis.fetch = (_url, options) => stalled(options);
    const config = { apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://fixture.invalid' };
    for (const Provider of [DeepSeekProvider, GeminiProvider]) {
        const provider = new Provider(config);
        const messages = [{ role: 'user', content: 'Synthetic fixture' }];
        await assert.rejects(provider.chat({ messages, timeoutMs: 5 }), { name: 'TimeoutError' });
        const controller = new AbortController();
        const pending = provider.chat({ messages, signal: controller.signal }); controller.abort();
        await assert.rejects(pending, { name: 'AbortError' });
    }
});
