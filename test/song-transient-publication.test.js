import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Song } from '../src/models/song.model.js';
import { createSongCache } from '../src/services/song-cache.service.js';

test('transient publication: a follower between Mongo commit and local publication joins existing work', async () => {
    const mongo = await MongoMemoryServer.create();
    try {
        await mongoose.connect(mongo.getUri()); await Song.init();
        let published, calls = 0, delayed = false;
        const committed = new Promise(resolve => { published = resolve; });
        // Deterministically expose the network-ack window: Mongo has committed,
        // but the winning caller has not yet published its bounded memory body.
        const Model = new Proxy(Song, { get(target, key) {
            if (key === 'updateOne') return async (...args) => {
                const result = await target.updateOne(...args);
                if (!delayed && args[1].$set?.['lyrics.status'] === 'transient') { delayed = true; published(); await new Promise(r => setTimeout(r, 100)); }
                return result;
            };
            const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } });
        const input = { title: 'Publication fixture', artist: 'Synthetic artist' };
        const cache = createSongCache({ Model, lookup: async () => { calls++; return { ...input, status: 'available', lyrics: 'Owned synthetic publication fixture', source: { name: 'LRCLIB' } }; },
            analyze: async () => ({ emotions: [], emotionAnalysis: { status: 'insufficient_evidence' } }) });
        const first = cache(input); await committed;
        const follower = cache(input);
        const result = await Promise.all([first, follower]);
        assert.equal(calls, 1, 'follower must not fetch during publication window');
        assert.ok(result.every(r => r.status === 'available'));
        assert.equal((await Song.findOne()).lyrics.text, null);
    } finally { await mongoose.disconnect(); await mongo.stop(); }
});
