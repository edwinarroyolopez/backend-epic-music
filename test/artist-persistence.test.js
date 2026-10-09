import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { Artist } from '../src/models/artist.model.js';
import { searchSimilarSongs } from '../src/services/music.service.js';

let mongo, server, base, answer;
const lyrics = 'Synthetic fragment for artist persistence tests';
const recommendations = Array.from({ length: 11 }, (_, index) => ({ title: `Fixture song ${index}`, artist: 'Recommendation fixture only', reason: 'Fixture comparison' }));
before(async () => {
    mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Artist.init();
    server = createApp({ search: body => searchSimilarSongs(body, { callAI: async ({ provider, messages }) => ({
        provider, model: 'artist-persistence-fixture', content: JSON.stringify(JSON.parse(messages[1].content).lyrics ? answer : { recommendations }),
    }) }) }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await mongo.stop(); });
async function search(artist) {
    const res = await fetch(`${base}/search-songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lyrics, artist, provider: 'deepseek' }) });
    return { status: res.status, ...(await res.json()) };
}
for (const [name, confidence, hint] of [['Lumen Quartet', .85, true], ['Copper Trio', .95, true], ['Obsidian Ensemble', .6, false]]) {
    test(`found:true persists ${name} at accepted confidence ${confidence}, before suggestions are read`, async () => {
        answer = { found: true, confidence, song: { title: 'Fixture source', artist: name } };
        const before = await fetch(`${base}/artists/suggest?q=${encodeURIComponent(name)}`);
        const etag = before.headers.get('etag');
        assert.deepEqual((await before.json()).data.artists, []);
        const result = await search(hint ? name : undefined);
        assert.equal(result.status, 200); assert.equal(result.data.found, true); assert.equal(result.data.count, 11);
        assert.equal(result.data.directory.status, 'saved');
        const doc = await Artist.findOne({ canonicalName: name }).lean();
        assert.ok(doc); assert.equal(doc.validationStatus, 'model_inferred');
        const suggestions = await fetch(`${base}/artists/suggest?q=${encodeURIComponent(name)}`, { headers: etag ? { 'If-None-Match': etag } : {} });
        assert.equal(suggestions.status, 200);
        assert.equal((await suggestions.json()).data.artists[0].canonicalName, name);
        assert.equal(suggestions.headers.get('cache-control'), 'no-cache');
        assert.equal(await Artist.countDocuments({ canonicalName: 'Recommendation fixture only' }), 0);
    });
}
test('concurrent identified variants produce one global artist; unrecognized hints do not get stored', async () => {
    answer = { found: true, confidence: .8, song: { title: 'Fixture source', artist: 'Violet Orchestra' } };
    const results = await Promise.all(['Violet Orchestra', 'violet orchestra', 'Violet'].map(search));
    assert.ok(results.every(result => result.data.directory.status === 'saved'));
    assert.equal(await Artist.countDocuments({ canonicalName: 'Violet Orchestra' }), 1);
    assert.equal((await Artist.findOne({ canonicalName: 'Violet Orchestra' })).usageCount, 3);
    answer = { found: true, confidence: .59, song: { title: 'Rejected fixture', artist: 'Below identification threshold' } };
    const miss = await search('Unrecognized raw input');
    assert.equal(miss.data.found, false);
    assert.equal(await Artist.countDocuments({ canonicalName: { $in: ['Unrecognized raw input', 'Below identification threshold'] } }), 0);
});
test('distinct identified names are not silently merged by fuzzy resolution during persistence', async () => {
    for (const name of ['Testmon Artist', 'Testman Artist']) {
        answer = { found: true, confidence: .95, song: { title: 'Fixture source', artist: name } };
        const result = await search(); assert.equal(result.data.directory.status, 'saved');
    }
    assert.equal(await Artist.countDocuments({ canonicalName: { $in: ['Testmon Artist', 'Testman Artist'] } }), 2);
});
test('database write failure preserves the result and explicitly reports directory unavailable', async () => {
    answer = { found: true, confidence: .95, song: { title: 'Fixture source', artist: 'Write Failure Fixture' } };
    const original = Artist.updateOne;
    Artist.updateOne = async () => { throw new Error('isolated write failure'); };
    try {
        const result = await search();
        assert.equal(result.status, 200); assert.equal(result.data.count, 11);
        assert.equal(result.data.directory.status, 'unavailable');
        assert.equal(await Artist.countDocuments({ canonicalName: 'Write Failure Fixture' }), 0);
    } finally { Artist.updateOne = original; }
});
