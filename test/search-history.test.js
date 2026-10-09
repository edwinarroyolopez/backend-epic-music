import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { User } from '../src/models/user.model.js';
import { Artist } from '../src/models/artist.model.js';
import { SearchHistory } from '../src/models/search-history.model.js';
import { Song } from '../src/models/song.model.js';
import { searchSimilarSongs } from '../src/services/music.service.js';
import { RETENTION_MS, finishHistory, reserveHistory } from '../src/services/search-history.service.js';
let mongo, server, base, users, tokens, calls, mode;
const secret = 'isolated-history-test-only';
const lyrics = 'Synthetic private fragment that must never persist';
const sign = (id, expiresIn = '1h') => jwt.sign({ sub: String(id) }, secret, { expiresIn });
async function request(path, token = tokens[0], method = 'GET', body, extra = {}) {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, ...(await response.json()) };
}
const search = (token = tokens[0], body = {}) => request('/search-songs', token, 'POST', { lyrics, provider: 'gemini', ...body });
before(async () => {
    process.env.JWT_SECRET = secret;
    mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
    await Promise.all([User.init(), Artist.init(), SearchHistory.init()]);
    users = await User.create(['a', 'b', 'disabled'].map(name => ({ username: name, name, email: `${name}@example.test`, phone: name, password: 'fixture', active: name !== 'disabled' })));
    tokens = users.map(u => sign(u.id));
});
beforeEach(async () => {
    calls = 0; mode = 'found';
    server = createApp({ reidentify: { identify: async () => ({ found: true, verification: 'lyrics_match', song: { title: 'Corrected published title', artist: 'History fixture artist', catalogVerified: true } }) }, search: input => searchSimilarSongs(input, { callAI: async ({ messages, provider }) => {
        calls++;
        await new Promise(r => setTimeout(r, mode === 'slow' ? 100 : 5));
        if (mode === 'error') throw new DOMException('fixture', 'TimeoutError');
        const identifying = Boolean(JSON.parse(messages[1].content).lyrics);
        if (mode === 'disconnect' && !identifying) await mongoose.disconnect();
        return { provider, model: 'history-fixture', content: JSON.stringify(mode === 'miss' ? { found: false } : identifying ?
            { found: true, confidence: .95, song: { title: 'History fixture source', artist: 'History fixture artist', genre: 'Rock' } } :
            { recommendations: Array.from({ length: 11 }, (_, i) => ({ title: `History fixture ${i}`, artist: 'Fixture', reason: 'Fixture affinity' })) }) };
    } }) }).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => { await new Promise(r => server.close(r)); if (mongoose.connection.readyState !== 1) await mongoose.connect(mongo.getUri()); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

test('JWT-owned search snapshot, isolation, full recommendations, reconnect and privacy', async () => {
    const result = await search(tokens[0], { artist: 'History fixture artist', genre: 'rock', owner: users[1].id });
    assert.equal(result.status, 200); assert.equal(result.data.history.status, 'saved');
    assert.match(result.data.song.songId, /^[a-f\d]{24}$/);
    assert.ok(result.data.recommendations.every(song => /^[a-f\d]{24}$/.test(song.songId)));
    assert.equal(await Song.countDocuments(), 12);
    assert.equal(await Song.countDocuments({ 'lyrics.lookupAttempted': true }), 0);
    const id = result.data.history.id;
    const detail = await request(`/search-history/${id}`);
    assert.equal(detail.headers.get('cache-control'), 'no-store');
    assert.equal(detail.data.entry.result.recommendations.length, 11);
    assert.equal(detail.data.entry.result.song.songId, result.data.song.songId);
    assert.equal(detail.data.entry.input.original.genre, 'rock');
    assert.equal(detail.data.entry.input.resolved.genre, 'Rock');
    assert.equal((await request(`/search-history/${id}`, tokens[1])).status, 404);
    assert.equal((await request(`/search-history/${id}`, tokens[1], 'DELETE')).status, 404);
    assert.equal((await request('/search-history', tokens[1])).data.entries.length, 0);
    await mongoose.disconnect(); await mongoose.connect(mongo.getUri());
    assert.equal((await request(`/search-history/${id}`)).data.entry.result.count, 11);
    const persisted = JSON.stringify(await SearchHistory.find({}).lean());
    assert.ok(!persisted.includes(lyrics)); assert.ok(!persisted.includes(tokens[0])); assert.ok(!persisted.includes(secret));
    assert.ok(!Object.hasOwn(detail.data.entry, 'owner'));
});
test('optional auth rejects invalid, expired, missing/inactive users; guests never write private history', async () => {
    const count = await SearchHistory.countDocuments();
    for (const token of ['forged', sign(users[0].id, '-1s'), sign(new mongoose.Types.ObjectId()), sign('demo')]) assert.equal((await search(token)).status, 401);
    assert.equal((await search(tokens[2])).status, 403);
    assert.equal(calls, 0);
    const guest = await request('/search-songs', null, 'POST', { lyrics, provider: 'gemini', userId: users[0].id }, { 'X-User-Id': users[0].id });
    assert.equal(guest.data.history.status, 'local_only');
    assert.equal(await SearchHistory.countDocuments(), count);
    for (const path of ['/search-history', `/search-history/${new mongoose.Types.ObjectId()}`]) assert.equal((await request(path, null)).status, 401);
});
test('concurrent searchId retries have one reservation and one AI sequence; replay does not write or call again', async () => {
    mode = 'slow'; const searchId = randomUUID();
    const replies = await Promise.all([search(tokens[0], { searchId }), search(tokens[0], { searchId })]);
    assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
    assert.equal(replies.find(r => r.status === 409).error.code, 'SEARCH_IN_PROGRESS');
    assert.equal(await SearchHistory.countDocuments({ requestId: searchId }), 1);
    assert.equal(calls, 2);
    const replay = await search(tokens[0], { searchId });
    assert.equal(replay.data.count, 11); assert.equal(calls, 2);
    assert.equal(replay.data.ai.attempts.length, 2);
    // Same UUID belongs to a different owner namespace, never replays A's row.
    mode = 'miss'; const b = await search(tokens[1], { searchId });
    assert.equal(b.data.found, false); assert.notEqual(b.data.history.id, replay.data.history.id);
});
test('not_found and provider timeout persisted; invalid body not accepted; Mongo failure never claims saved', async () => {
    mode = 'miss'; const miss = await search(); assert.equal(miss.data.history.status, 'saved');
    assert.equal((await request(`/search-history/${miss.data.history.id}`)).data.entry.status, 'not_found');
    mode = 'error'; const searchId = randomUUID(), error = await search(tokens[0], { searchId });
    assert.equal(error.status, 502); assert.equal(error.history.status, 'saved');
    assert.equal((await request(`/search-history/${error.history.id}`)).data.entry.errorCode, 'PROVIDER_ERROR');
    const before = calls; assert.equal((await search(tokens[0], { searchId })).status, 502); assert.equal(calls, before);
    const count = await SearchHistory.countDocuments();
    assert.equal((await search(tokens[0], { lyrics: 'short' })).status, 400);
    assert.equal((await search(tokens[0], { searchId: 'bad' })).status, 400);
    assert.equal(await SearchHistory.countDocuments(), count);
    mode = 'disconnect'; const failedWrite = await search();
    assert.equal(failedWrite.status, 200); assert.equal(failedWrite.data.history.status, 'unavailable'); assert.equal(failedWrite.data.count, 11);
    mode = 'found'; const offline = await search();
    assert.equal(offline.status, 200); assert.equal(offline.data.history.status, 'unavailable');
    assert.equal(offline.data.input.directoryStatus, 'unavailable');
    assert.equal((await request('/search-history')).status, 503);
});
test('stable cursor, invalid limits/IDs, expiration, interrupted pending and count retention', async () => {
    const first = await request('/search-history?limit=2');
    assert.equal(first.data.entries.length, 2); assert.ok(first.data.nextCursor);
    const second = await request(`/search-history?limit=2&cursor=${first.data.nextCursor}`);
    assert.ok(second.data.entries.every(e => !first.data.entries.some(f => e.id === f.id)));
    for (const path of ['/search-history?limit=0', '/search-history?limit=51', '/search-history?cursor=bad', '/search-history/not-id']) assert.equal((await request(path)).status, 400);
    const old = await SearchHistory.create({ owner: users[0].id, requestId: randomUUID(), status: 'pending', createdAt: new Date(Date.now() - 360000), expiresAt: new Date(Date.now() + RETENTION_MS) });
    assert.equal((await request(`/search-history/${old.id}`)).data.entry.errorCode, 'INTERRUPTED');
    await SearchHistory.updateOne({ _id: old.id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    assert.equal((await request(`/search-history/${old.id}`)).status, 404);
    const owner = users[1].id;
    await SearchHistory.insertMany(Array.from({ length: 205 }, () => ({ owner, requestId: randomUUID(), status: 'not_found', expiresAt: new Date(Date.now() + RETENTION_MS) })));
    const { doc } = await reserveHistory(owner, randomUUID(), {});
    await finishHistory(doc, { result: { found: false, song: null, recommendations: [], count: 0 }, input: {} });
    assert.equal(await SearchHistory.countDocuments({ owner, status: { $ne: 'pending' } }), 200);
    const plan = await SearchHistory.find({ owner }).sort({ createdAt: -1, _id: -1 }).limit(20).explain('executionStats');
    assert.ok(JSON.stringify(plan.queryPlanner.winningPlan).includes('IXSCAN'));
    const pending = first.data.entries.find(e => e.status === 'pending');
    if (pending) assert.equal((await request(`/search-history/${pending.id}`, tokens[0], 'DELETE')).status, 409);
    const id = (await SearchHistory.findOne({ owner: users[0].id, status: 'found' })).id;
    assert.equal((await request(`/search-history/${id}`, tokens[0], 'DELETE')).data.deleted, true);
    assert.equal((await request(`/search-history/${id}`)).status, 404);
});
test('client cancellation after acceptance may complete on server, with a single durable entry', async () => {
    mode = 'slow'; const searchId = randomUUID(), controller = new AbortController();
    const promise = fetch(`${base}/search-songs`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[0]}` }, body: JSON.stringify({ lyrics, provider: 'gemini', searchId }) }).catch(e => e);
    for (let i = 0; i < 40 && !await SearchHistory.exists({ requestId: searchId }); i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(await SearchHistory.exists({ requestId: searchId })); controller.abort();
    assert.equal((await promise).name, 'AbortError');
    for (let i = 0; i < 60 && !await SearchHistory.exists({ requestId: searchId, status: 'found' }); i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(await SearchHistory.countDocuments({ requestId: searchId, status: 'found' }), 1);
});

test('fresh production processes load persisted history and global directory after restart', { timeout: 20000 }, async () => {
    const saved = await search();
    for (let restart = 0; restart < 2; restart++) {
        const child = spawn(process.execPath, ['src/server.js'], {
            env: { ...process.env, MONGODB_URI: mongo.getUri(), PORT: '0', LEGACY_HTTP_PORT: '0', JWT_SECRET: secret }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        try {
            const port = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Startup timeout')), 8000);
                child.once('exit', () => { clearTimeout(timer); reject(new Error('Startup exited')); });
                child.stdout.on('data', chunk => { const match = String(chunk).match(/escuchando en puerto (\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
            });
            const url = `http://127.0.0.1:${port}`;
            let health;
            for (let i = 0; i < 80; i++) { health = await fetch(`${url}/health`); if (health.ok) break; await new Promise(r => setTimeout(r, 25)); }
            assert.equal(health.status, 200);
            const detail = await fetch(`${url}/search-history/${saved.data.history.id}`, { headers: { Authorization: `Bearer ${tokens[0]}` } });
            assert.equal(detail.status, 200);
            assert.equal((await detail.json()).data.entry.result.recommendations.length, 11);
            const suggestions = await fetch(`${url}/artists/suggest?q=History`);
            assert.equal((await suggestions.json()).data.artists[0].canonicalName, 'History fixture artist');
        } finally {
            const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); if (child.exitCode === null) await exited;
        }
    }
});

test('corrected history survives reload with a new song reference and can be saved with recommendations', async () => {
    const saved = await search();
    const historyId = saved.data.history.id, originalId = saved.data.song.songId;
    const body = { lyrics, historyId, previous: { title: saved.data.song.title, artist: saved.data.song.artist } };
    assert.equal((await request('/reidentify-song', tokens[1], 'POST', body)).status, 404);
    assert.equal((await request('/reidentify-song', null, 'POST', body)).status, 401);
    const corrected = await request('/reidentify-song', tokens[0], 'POST', body);
    assert.equal(corrected.status, 200); assert.equal(corrected.data.history.status, 'saved');
    assert.notEqual(corrected.data.song.songId, originalId);
    const detail = (await request(`/search-history/${historyId}`)).data.entry;
    assert.equal(detail.song.title, 'Corrected published title'); assert.equal(detail.result.song.catalogVerified, true);
    assert.equal(detail.result.recommendations.length, 11);
    assert.equal((await Song.findById(originalId)).title, saved.data.song.title);
    assert.ok(!JSON.stringify(await SearchHistory.findById(historyId).lean()).includes(lyrics));
    const songs = [detail.result.song, detail.result.recommendations[0]].map((song, index) => ({ title: song.title, artist: song.artist, songId: song.songId, originType: index ? 'recommendation' : 'identified', catalogVerified: false }));
    const playlist = await request('/playlists', tokens[0], 'POST', { name: 'History selection', songs });
    assert.equal(playlist.status, 201); assert.equal(playlist.data.addedCount, 2);
    assert.equal(playlist.data.playlist.songs[0].songId, corrected.data.song.songId);
    const added = await request(`/playlists/${playlist.data.playlist.id}/songs`, tokens[0], 'POST', { songs });
    assert.equal(added.status, 200); assert.equal(added.data.addedCount, 0); assert.equal(added.data.skippedCount, 2);
});
