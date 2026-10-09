import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Artist, artistKeys } from '../src/models/artist.model.js';
import { SearchHistory } from '../src/models/search-history.model.js';
let mongo;
before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all([Artist.init(), SearchHistory.init()]); });
after(async () => { await mongoose.disconnect(); await mongo?.stop(); });
test('global artist atomic unique identity and lookup indexes; history private keys and TTL', async () => {
    const canonicalName = 'Mindless Self Indulgence';
    await Promise.all(Array.from({ length: 8 }, () => Artist.updateOne({ normalizedKey: artistKeys(canonicalName).normalizedKey }, {
        $setOnInsert: { canonicalName, ...artistKeys(canonicalName), validationStatus: 'curated', source: 'curation' }, $inc: { usageCount: 1 },
    }, { upsert: true })));
    assert.equal(await Artist.countDocuments(), 1);
    assert.equal((await Artist.findOne()).usageCount, 8);
    const indexes = await Artist.collection.indexes();
    assert.ok(indexes.some(i => i.key.normalizedKey && i.unique));
    assert.ok(indexes.some(i => i.key.searchKeys));
    assert.ok(indexes.some(i => i.key.grams));
    const historyIndexes = await SearchHistory.collection.indexes();
    assert.ok(historyIndexes.some(i => i.key.owner && i.key.requestId && i.unique));
    assert.ok(historyIndexes.some(i => i.expireAfterSeconds === 0));
});
test('history schema strips arbitrary input/result secrets and never has a lyrics field', async () => {
    const entry = await SearchHistory.create({ owner: new mongoose.Types.ObjectId(), requestId: 'synthetic-id', status: 'not_found', expiresAt: new Date(Date.now() + 10000),
        lyrics: 'private fixture', token: 'private fixture', input: { original: { artist: 'Name', lyrics: 'private fixture' } },
        result: { found: false, lyrics: 'private fixture', ai: { apiKey: 'private fixture' } } });
    const serialized = JSON.stringify(entry.toObject());
    assert.ok(!serialized.includes('private fixture'));
});
