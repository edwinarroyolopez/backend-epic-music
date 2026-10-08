import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { spawn } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { User } from '../src/models/user.model.js';
import { Playlist } from '../src/models/playlist.model.js';

let mongo, server, base, a, b, disabled;
const secret = 'test-only-never-production';
const token = (id, expiresIn = '1h') => jwt.sign({ sub: String(id) }, secret, { expiresIn });
const song = (title = 'Épica') => ({ title, artist: 'Artist', originType: 'recommendation', reason: 'Synthetic test', catalogVerified: false });
async function request(path, auth = a, method = 'GET', body) {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
}
before(async () => {
    process.env.JWT_SECRET = secret;
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'epic_isolated_test' });
    await Promise.all([User.init(), Playlist.init()]);
    const users = await User.create(['a', 'b', 'disabled'].map(name => ({ username: name, name, email: `${name}@example.test`, phone: name, password: 'test-only', active: name !== 'disabled' })));
    [a, b, disabled] = users.map(user => token(user.id));
    server = createApp().listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
});

test('every playlist route requires JWT and active existing account', async () => {
    const id = new mongoose.Types.ObjectId();
    for (const [method, path] of [['GET', ''], ['POST', ''], ['GET', `/${id}`], ['PATCH', `/${id}`], ['DELETE', `/${id}`], ['POST', `/${id}/songs`], ['DELETE', `/${id}/songs/${id}`], ['PATCH', `/${id}/songs/order`]]) {
        assert.equal((await request(`/playlists${path}`, null, method)).status, 401);
        assert.equal((await request(`/playlists${path}`, disabled, method)).status, 403);
    }
    assert.equal((await request('/playlists', token(id))).status, 401);
    assert.equal((await request('/playlists', token(id, '-1s'))).status, 401);
    assert.equal((await request('/auth/me', disabled)).status, 403);
    assert.equal((await request('/health', null)).data.database, 'connected');
    assert.equal((await request('/auth/providers', null)).email, true);
});

test('production entrypoint starts with isolated Mongo and responds to health', async () => {
    const child = spawn(process.execPath, ['src/server.js'], {
        env: { ...process.env, MONGODB_URI: mongo.getUri('epic_start_test'), PORT: '0', JWT_SECRET: secret },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
        const port = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Startup timeout')), 10000);
            child.on('exit', () => { clearTimeout(timer); reject(new Error('Server exited before readiness')); });
            child.stdout.on('data', chunk => {
                const match = String(chunk).match(/escuchando en puerto (\d+)/);
                if (match) { clearTimeout(timer); resolve(match[1]); }
            });
        });
        // TCP is available before Mongo/indices. Readiness must eventually be 200.
        let response;
        for (let attempt = 0; attempt < 100; attempt++) {
            response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.status === 200) break;
            assert.equal(response.status, 503);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(response.status, 200);
        const health = await response.json();
        assert.equal(health.data.database, 'connected');
        assert.equal(health.data.ready, true);
    } finally {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        if (child.exitCode === null) await exited;
    }
});

test('atomic creation, dedupe, owner isolation, metadata, remove/order, reconnect persistence', async () => {
    const created = await request('/playlists', a, 'POST', { name: 'Test', description: 'Original', songs: [song(), song(' epica '), { ...song('Source'), originType: 'identified', album: 'Album', releaseYear: 2020 }] });
    assert.equal(created.status, 201);
    assert.equal(created.data.addedCount, 2);
    assert.equal(created.data.skippedCount, 1);
    const id = created.data.playlist.id, path = `/playlists/${id}`;
    for (const [method, suffix, body] of [['GET', ''], ['PATCH', '', { name: 'Stolen' }], ['DELETE', ''], ['POST', '/songs', { songs: [song()] }], ['DELETE', `/songs/${created.data.playlist.songs[0].id}`], ['PATCH', '/songs/order', { songIds: [] }]]) {
        assert.equal((await request(path + suffix, b, method, body)).status, 404);
    }
    assert.equal((await request('/playlists', b)).data.playlists.length, 0);
    const edited = await request(path, a, 'PATCH', { name: 'Renamed', description: 'Updated' });
    assert.equal(edited.data.playlist.name, 'Renamed');
    const ids = created.data.playlist.songs.map(s => s.id).reverse();
    const reordered = await request(`${path}/songs/order`, a, 'PATCH', { songIds: ids });
    assert.deepEqual(reordered.data.playlist.songs.map(s => s.id), ids);
    assert.equal(reordered.data.playlist.songs[0].album, 'Album');
    assert.equal((await request(`${path}/songs/order`, a, 'PATCH', { songIds: ids.slice(1) })).status, 409);
    assert.equal((await request(`${path}/songs/order`, a, 'PATCH', { songIds: [ids[0], ids[0]] })).status, 400);
    await mongoose.disconnect();
    await mongoose.connect(mongo.getUri(), { dbName: 'epic_isolated_test' });
    assert.deepEqual((await request(path)).data.playlist.songs.map(s => s.id), ids);
    const removed = await request(`${path}/songs/${ids[0]}`, a, 'DELETE');
    assert.equal(removed.data.playlist.songCount, 1);
    assert.equal((await request(path, a, 'DELETE')).status, 200);
    assert.equal((await request(path)).status, 404);
});

test('simultaneous additions merge without lost updates or duplicates', async () => {
    const { data } = await request('/playlists', a, 'POST', { name: 'Concurrent' });
    const path = `/playlists/${data.playlist.id}`;
    const results = await Promise.all([
        request(`${path}/songs`, a, 'POST', { songs: [song('One'), song('Shared')] }),
        request(`${path}/songs`, a, 'POST', { songs: [song('Two'), song('Shared')] }),
    ]);
    assert.ok(results.every(r => r.status === 200));
    assert.equal(results.reduce((sum, r) => sum + r.data.addedCount, 0), 3);
    assert.equal(results.reduce((sum, r) => sum + r.data.skippedCount, 0), 1);
    assert.equal((await request(path)).data.playlist.songCount, 3);
    const duplicate = await request(`${path}/songs`, a, 'POST', { songs: [song('Shared')] });
    assert.equal(duplicate.data.addedCount, 0);
});

test('strict validation and invalid create never leave an empty playlist', async () => {
    const initial = (await request('/playlists')).data.playlists.length;
    for (const body of [null, [], {}, { name: '' }, { name: 'x'.repeat(101) }, { name: 'x', owner: new mongoose.Types.ObjectId() }, { name: 'x', songs: [song(), { title: 'Missing artist' }] }, { name: 'x', songs: [{ ...song(), catalogVerified: true }] }, { name: 'x', songs: [{ ...song(), lyrics: 'Never store this' }] }, { name: 'x', songs: Array.from({ length: 101 }, () => song()) }]) {
        assert.equal((await request('/playlists', a, 'POST', body)).status, 400);
    }
    assert.equal((await request('/playlists')).data.playlists.length, initial);
    assert.equal((await request('/playlists', a, 'POST', { name: 'Invalid null songs', songs: null })).status, 400);
    assert.equal((await request('/playlists')).data.playlists.length, initial);
    assert.equal((await request('/playlists/not-an-id')).status, 400);
});

test('500-song and 100-playlist caps enforced, including concurrent creates', async () => {
    const { data } = await request('/playlists', b, 'POST', { name: 'Capacity' });
    for (let batch = 0; batch < 5; batch++) {
        assert.equal((await request(`/playlists/${data.playlist.id}/songs`, b, 'POST', { songs: Array.from({ length: 100 }, (_, i) => song(`${batch}-${i}`)) })).status, 200);
    }
    assert.equal((await request(`/playlists/${data.playlist.id}/songs`, b, 'POST', { songs: [song('Overflow')] })).status, 409);
    const owner = jwt.verify(b, secret).sub;
    await Playlist.insertMany(Array.from({ length: 98 }, (_, i) => ({ owner, slot: i + 1, name: 'Limit test', songs: [] })));
    const responses = await Promise.all([request('/playlists', b, 'POST', { name: 'Last' }), request('/playlists', b, 'POST', { name: 'Overflow' })]);
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    assert.equal(await Playlist.countDocuments({ owner }), 100);
});
