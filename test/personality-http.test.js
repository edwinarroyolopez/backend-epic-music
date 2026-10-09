import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { PlaylistAnalysis } from '../src/models/playlist-analysis.model.js';
import { Song } from '../src/models/song.model.js';
import { Playlist } from '../src/models/playlist.model.js';
import { User } from '../src/models/user.model.js';
let mongo, server, base, a, b, calls = 0;
const songs = Array.from({ length: 8 }, (_, i) => ({ title: `Synthetic ${i}`, artist: `Artist ${i % 3}`, genre: i % 2 ? 'Rock' : 'Folk' }));
const input = () => ({ sourceMode: 'manual', songs, title: 'Eight synthetic songs', consent: true, independentSource: true, language: 'es', requestId: randomUUID() });
async function request(path, { token, body, method = body ? 'POST' : 'GET' } = {}) {
    const res = await fetch(base + path, { method, headers: { ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) });
    return { status: res.status, cache: res.headers.get('cache-control'), retryAfter: res.headers.get('retry-after'), exposed: res.headers.get('access-control-expose-headers'), ...await res.json() };
}
before(async () => {
    process.env.JWT_SECRET = 'personality-http-isolated-secret'; mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
    await Promise.all([Song.init(), Playlist.init(), User.init(), PlaylistAnalysis.init()]);
    server = createApp({ personality: { callAI: async ({ messages }) => { calls++; const d = JSON.parse(messages[1].content); return { provider: 'fixture', model: 'synthetic', content: JSON.stringify({ version: d.version, focus: d.candidates, representativeIndices: [0, 1] }) }; } } }).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
    const signup = suffix => request('/auth/signup', { body: { username: `personality_${suffix}`, name: `Synthetic ${suffix}`, email: `${suffix}@example.test`, phone: `1234567${suffix}`, password: 'Synthetic-Password123!' } });
    a = await signup('a'); b = await signup('b'); assert.ok(a.token && b.token);
});
after(async () => { await new Promise(r => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });
test('HTTP privacy: real JWT A/B/guest, no-store, cache reopen/delete without cascade, invalid consent', async () => {
    const beforeCalls = calls;
    assert.equal((await request('/playlist-personality/analyze', { body: { ...input(), consent: false } })).status, 400);
    assert.equal((await request('/playlist-personality/analyze', { body: { ...input(), songs: songs.slice(0, 1) } })).status, 400);
    assert.equal(calls, beforeCalls);
    const first = await request('/playlist-personality/analyze', { token: a.token, body: input() });
    assert.equal(first.status, 200); assert.equal(first.data.saved, true); assert.equal(first.cache, 'no-store');
    const id = first.data.entry.id, beforeReopen = calls;
    const detail = await request(`/playlist-personality/history/${id}`, { token: a.token });
    assert.deepEqual(detail.data.entry, first.data.entry); assert.equal(calls, beforeReopen);
    assert.equal((await request('/playlist-personality/history')).status, 401);
    assert.equal((await request('/playlist-personality/history', { token: 'invalid' })).status, 401);
    for (const method of ['GET', 'DELETE']) assert.equal((await request(`/playlist-personality/history/${id}`, { token: b.token, method })).status, 404);
    const count = await Song.countDocuments();
    assert.equal((await request(`/playlist-personality/history/${id}`, { token: a.token, method: 'DELETE' })).status, 200);
    assert.equal(await Song.countDocuments(), count);
    assert.equal((await request(`/playlist-personality/history/${id}`, { token: a.token })).status, 404);
    const guestCount = await PlaylistAnalysis.countDocuments(); await request('/playlist-personality/analyze', { body: input() });
    assert.equal(await PlaylistAnalysis.countDocuments(), guestCount);
    assert.equal(await Song.countDocuments(), count);
});
test('HTTP history: stable 20-entry cursor, TTL filtering and account partition', async () => {
    const seed = await request('/playlist-personality/analyze', { token: a.token, body: input() }); assert.equal(seed.status, 200);
    const doc = await PlaylistAnalysis.findById(seed.data.entry.id).lean();
    await PlaylistAnalysis.insertMany(Array.from({ length: 22 }, (_, i) => ({ ...doc, _id: new mongoose.Types.ObjectId(), requestIds: [randomUUID()], contentHash: `synthetic-pagination-${i}`, expiresAt: i === 21 ? new Date(0) : doc.expiresAt })));
    const first = await request('/playlist-personality/history', { token: a.token }); assert.equal(first.data.entries.length, 20); assert.ok(first.data.nextCursor);
    const second = await request(`/playlist-personality/history?cursor=${first.data.nextCursor}`, { token: a.token }); assert.equal(second.data.entries.length, 2);
    assert.ok(second.data.entries.every(e => !first.data.entries.some(s => s.id === e.id)));
    assert.equal((await request('/playlist-personality/history', { token: b.token })).data.entries.length, 0);
    assert.equal((await request('/playlist-personality/history?cursor=bad', { token: a.token })).status, 400);
    assert.ok(!JSON.stringify(first).includes('songId'));
});
test('HTTP analysis limiter returns CORS-exposed Retry-After without additional AI', async () => {
    const beforeCalls = calls; let last;
    for (let i = 0; i < 12; i++) last = await request('/playlist-personality/analyze', { token: a.token, body: { ...input(), consent: false } });
    assert.equal(last.status, 429); assert.ok(Number(last.retryAfter) > 0); assert.match(last.exposed, /Retry-After/i); assert.equal(calls, beforeCalls);
});
