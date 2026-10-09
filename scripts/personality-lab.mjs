import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createServer } from '../../frontend-epic-music/node_modules/vite/dist/node/index.js';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createApp } from '../src/app.js';
import { Song } from '../src/models/song.model.js';
import { Playlist } from '../src/models/playlist.model.js';
import { User } from '../src/models/user.model.js';

export async function startLab(personality) {
    process.env.JWT_SECRET = 'personality-isolated-test-secret';
    const mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([Song.init(), Playlist.init(), User.init()]);
    const server = createApp({ personality, search: () => { throw new Error('Unexpected search'); }, lyrics: {} }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.VITE_API_URL = base;
    const vite = await createServer({ root: fileURLToPath(new URL('../../frontend-epic-music', import.meta.url)), server: { host: '127.0.0.1', port: 5173, strictPort: true }, logLevel: 'error' });
    await vite.listen();
    const browser = await chromium.launch({ headless: true });
    const api = async (path, { body, token, method = body ? 'POST' : 'GET' } = {}) => {
        const response = await fetch(`${base}${path}`, { method, headers: { ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) });
        return { status: response.status, ...await response.json() };
    };
    return { browser, base, api, ui: 'http://127.0.0.1:5173', close: async () => { await browser.close(); await vite.close(); await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await mongo.stop(); } };
}
