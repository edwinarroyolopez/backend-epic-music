import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Song, canonicalSongKey, songSummary } from '../src/models/song.model.js';
import { resolveSong, requireSongStore } from '../src/services/song-identity.service.js';
let mongo;
before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Song.init(); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
test('20 concurrent resolutions share UNIQUE identity; NFC/spaces/case only, accents/punctuation/edition preserved', async () => {
    const input = { title: 'Café!', artist: 'Fixture' };
    const docs = await Promise.all(Array.from({ length: 20 }, (_, i) => resolveSong(i % 2 ? input : { title: ' CAFE\u0301! ', artist: 'fixture' })));
    assert.equal(new Set(docs.map(d => String(d._id))).size, 1);
    for (const variant of [{ title: 'Cafe!' }, { title: 'Café' }, { artist: 'Another' }, { edition: 'live' }]) assert.notEqual(String((await resolveSong({ ...input, ...variant }))._id), String(docs[0]._id));
    await assert.rejects(Song.create({ ...input, canonicalKey: canonicalSongKey(input) }), { code: 11000 });
    assert.equal(await Song.countDocuments(), 5);
    assert.deepEqual(Object.keys(songSummary(docs[0])).sort(), ['songId', 'title', 'artist', 'edition', 'catalogVerified', 'lookupAttempted', 'lyricsLookupStatus'].sort());
});
test('strict schema and invariants reject unauthorized content and invalid identities', async () => {
    const input = { title: 'Invalid', artist: 'Fixture' };
    const doc = new Song({ ...input, canonicalKey: canonicalSongKey(input), privateToken: 'secret' });
    assert.equal(doc.toObject().privateToken, undefined);
    doc.lyrics.status = 'available'; doc.lyrics.text = 'Own synthetic content';
    await assert.rejects(doc.validate());
    await assert.rejects(resolveSong({ title: '', artist: 'X' }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(resolveSong({ songId: (await Song.findOne()).id, title: 'Wrong', artist: 'Fixture' }), { code: 'SONG_IDENTITY_MISMATCH' });
});
test('missing unique index fails closed', async () => {
    await Song.collection.dropIndex('canonicalKey_1');
    await assert.rejects(requireSongStore(), { code: 'SONG_CACHE_UNAVAILABLE' });
    await Song.createIndexes();
});
