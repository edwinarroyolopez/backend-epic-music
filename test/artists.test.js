import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { Artist } from '../src/models/artist.model.js';
import { resolveArtist, acceptIdentifiedArtist } from '../src/services/artist.service.js';
import { searchSimilarSongs } from '../src/services/music.service.js';
let mongo, server, base;
before(async () => {
    process.env.JWT_SECRET = 'artist-test-only';
    mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Artist.init();
    server = createApp({ search: input => searchSimilarSongs(input, { callAI: async ({ messages, provider }) => ({ provider, model: 'test-only', content: JSON.stringify(JSON.parse(messages[1].content).lyrics ?
        { found: true, confidence: .96, song: { title: 'Synthetic origin', artist: 'Mindless Self Indulgence' } } :
        { recommendations: Array.from({ length: 11 }, (_, i) => ({ title: `Fixture ${i}`, artist: 'Fixture band', reason: 'Fixture comparison' })) }) }) }) }).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(r => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });
test('canonical artist learned from lyrics is globally available to A, B, guests and after reconnect', async () => {
    // Identity-independent global directory: JWT, if supplied, is irrelevant to suggestions.
    const result = await fetch(`${base}/search-songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lyrics: 'Synthetic identification fragment', provider: 'gemini' }) });
    assert.equal((await result.json()).data.directory.status, 'saved');
    for (const owner of [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), null]) {
        const response = await fetch(`${base}/artists/suggest?q=mindl`, { headers: owner ? { Authorization: `Bearer ${jwt.sign({ sub: String(owner) }, process.env.JWT_SECRET)}` } : {} });
        const { data } = await response.json();
        assert.equal(data.artists[0].canonicalName, 'Mindless Self Indulgence');
        assert.deepEqual(Object.keys(data.artists[0]).sort(), ['canonicalName', 'id', 'validationStatus']);
    }
    await mongoose.disconnect(); await mongoose.connect(mongo.getUri());
    assert.equal((await resolveArtist('Mindles Self Indulgence')).value, 'Mindless Self Indulgence');
});
test('concurrent corrected aliases keep one canonical document; raw hints and rejected identifications not promoted', async () => {
    const resolution = await resolveArtist('Mindles Self Indulgence');
    await Promise.all(Array.from({ length: 8 }, () => acceptIdentifiedArtist({ title: 'Fixture source', artist: resolution.value, modelConfidence: .95 }, { originalArtist: 'Mindles Self Indulgence', resolution })));
    assert.equal(await Artist.countDocuments(), 1);
    assert.deepEqual((await Artist.findOne()).aliases, ['Mindles Self Indulgence']);
    assert.equal((await resolveArtist('Mindles Self Indulgence')).source, 'catalog_alias');
    await acceptIdentifiedArtist(null, { originalArtist: 'Raw input only', resolution: { recognized: false } });
    await acceptIdentifiedArtist({ title: 'Rejected fixture', artist: 'Weak inferred', modelConfidence: .59 });
    assert.equal(await Artist.countDocuments(), 1);
});
test('prefix queries use multikey index; bounds, regex text and Mongo outage are explicit', async () => {
    const plan = await Artist.find({ searchKeys: { $elemMatch: { $gte: 'mind', $lt: 'mind\uffff' } } }).hint({ searchKeys: 1 }).explain('executionStats');
    assert.ok(JSON.stringify(plan.queryPlanner.winningPlan).includes('IXSCAN'));
    for (const query of ['', 'q=x', 'q=ok&limit=11', 'q=ok&limit=0', 'q=ok&limit=1.5', 'q=a&q=b', `q=${'x'.repeat(201)}`]) assert.equal((await fetch(`${base}/artists/suggest?${query}`)).status, 400);
    const literal = await fetch(`${base}/artists/suggest?q=${encodeURIComponent('.*(a+)+$')}`);
    assert.equal(literal.status, 200);
    assert.deepEqual((await literal.json()).data.artists, []);
    await mongoose.disconnect();
    assert.equal((await fetch(`${base}/artists/suggest?q=mind`)).status, 503);
    await mongoose.connect(mongo.getUri());
});
test('suggestions rate limit cannot be bypassed with forged forwarded IP', async () => {
    let limited = false;
    for (let i = 0; i < 61; i++) {
        const response = await fetch(`${base}/artists/suggest?q=mind`, { headers: { 'X-Forwarded-For': `192.0.2.${i}` } });
        if (response.status === 429) { limited = true; assert.ok(response.headers.get('retry-after')); break; }
    }
    assert.ok(limited);
});
