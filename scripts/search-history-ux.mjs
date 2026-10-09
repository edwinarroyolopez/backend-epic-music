import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { chromium, expect } from '@playwright/test';
import { createServer } from '../../frontend-epic-music/node_modules/vite/dist/node/index.js';
import { createApp } from '../src/app.js';
import { reidentifySong } from '../src/services/song-reidentification.service.js';
import { User } from '../src/models/user.model.js';
import { Song } from '../src/models/song.model.js';
import { Playlist } from '../src/models/playlist.model.js';
import { SearchHistory } from '../src/models/search-history.model.js';

test('source correction, refreshed lyrics, history multi-selection and individual playlist saves in desktop/mobile', { timeout: 120000 }, async () => {
    process.env.JWT_SECRET = 'isolated-search-history-browser-test';
    const mongo = await MongoMemoryServer.create();
    let server, vite, browser;
    const fragment = 'Distinctive synthetic words drift across the river';
    const record = { trackName: 'Published title', artistName: 'Fixture artist', plainLyrics: `Opening\n${fragment}\nClosing` };
    const lyricsRequests = [], errors = [];
    try {
        await mongoose.connect(mongo.getUri());
        await Promise.all([User.init(), Song.init(), Playlist.init(), SearchHistory.init()]);
        const user = await User.create({ username: 'ux-fixture', name: 'UX Fixture', email: 'ux@example.test', phone: 'fixture', password: 'fixture', active: true });
        const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
        server = createApp({
            search: async ({ lyrics, artist }) => ({ found: true,
                song: { title: lyrics === fragment ? 'Wrong first verse title' : 'Second source', artist: 'Fixture artist', catalogVerified: false },
                recommendations: Array.from({ length: 11 }, (_, index) => ({ title: `Recommendation ${index + 1}`, artist: 'Other artist', reason: 'Synthetic affinity' })),
                count: 11, input: { original: { artist }, resolved: { artist }, corrections: [] },
            }),
            reidentify: { identify: (input, options) => reidentifySong(input, { ...options, search: async () => [record], callAI: async () => ({ content: '{"candidates":[]}' }) }) },
            lyrics: async song => {
                lyricsRequests.push(song);
                return { ...song, status: song.title === record.trackName ? 'available' : 'not_found',
                    lyrics: song.title === record.trackName ? record.plainLyrics : null, source: { name: 'LRCLIB' } };
            },
        }).listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        process.env.VITE_API_URL = base;
        vite = await createServer({ root: fileURLToPath(new URL('../../frontend-epic-music', import.meta.url)), server: { host: '127.0.0.1', port: 5173, strictPort: true }, logLevel: 'error' });
        await vite.listen();
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, reducedMotion: 'reduce' });
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(token => { localStorage.setItem('me:token', token); localStorage.setItem('me:language', '"es"'); }, token);
        const ui = 'http://127.0.0.1:5173';
        await page.goto(ui);
        await page.getByLabel('Fragmento de letra', { exact: true }).fill(fragment);
        await page.getByLabel('Artista (opcional)', { exact: true }).fill('Fixture artist');
        await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
        const source = page.locator('.song-card--source');
        await expect(source.getByRole('heading', { name: 'Wrong first verse title', exact: true })).toBeVisible();
        await source.getByRole('button', { name: 'Ver letra completa', exact: true }).click();
        await expect(source.getByText('No hay una letra completa', { exact: false })).toBeVisible();
        const oldId = lyricsRequests.at(-1).songId;
        await source.getByRole('button', { name: 'Volver a identificar', exact: true }).click();
        await expect(page.getByRole('dialog').getByLabel('Fragmento de letra', { exact: true })).toHaveValue(fragment);
        await page.getByRole('button', { name: 'Verificar con el fragmento', exact: true }).click();
        await expect(source.getByRole('heading', { name: record.trackName, exact: true })).toBeVisible();
        await expect(source.locator('.lyrics-text')).toContainText(fragment);
        assert.notEqual(lyricsRequests.at(-1).songId, oldId);
        assert.equal(lyricsRequests.at(-1).title, record.trackName);
        await page.getByRole('link', { name: 'Ver resultado guardado', exact: true }).click();
        await expect(source.getByRole('heading', { name: record.trackName, exact: true })).toBeVisible();
        const historyId = page.url().split('/').at(-1);
        await source.getByRole('checkbox').check();
        await page.locator('.recommendations__grid .song-card').first().getByRole('checkbox').check();
        await page.getByRole('button', { name: 'Guardar selección', exact: true }).click();
        await page.getByRole('dialog').getByLabel('Nombre de playlist', { exact: true }).fill('From history');
        await page.getByRole('button', { name: 'Crear con selección', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        let playlist = await Playlist.findOne({ owner: user.id, name: 'From history' }).lean();
        assert.equal(playlist.songs.length, 2); assert.equal(playlist.songs[0].title, record.trackName);
        assert.equal(String(playlist.songs[0].songId), lyricsRequests.at(-1).songId);
        await page.locator('.recommendations__grid .song-card').nth(1).getByRole('button', { name: 'Añadir a playlist', exact: true }).click();
        await page.getByRole('button', { name: 'Añadir a existente', exact: true }).click();
        await page.getByRole('combobox', { name: 'Elige una playlist' }).selectOption(String(playlist._id));
        await page.getByRole('button', { name: 'Añadir canciones', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        playlist = await Playlist.findById(playlist._id).lean(); assert.equal(playlist.songs.length, 3);
        // A reload has no stored lyrics, so old history explicitly asks for a fragment.
        await page.reload();
        await source.getByRole('button', { name: 'Volver a identificar', exact: true }).click();
        await expect(page.getByRole('dialog').getByLabel('Fragmento de letra', { exact: true })).toHaveValue('');
        await page.getByRole('dialog').getByLabel('Fragmento de letra', { exact: true }).fill('A different synthetic fragment with no match');
        await page.getByRole('button', { name: 'Verificar con el fragmento', exact: true }).click();
        await expect(page.getByText('No pudimos confirmar una coincidencia', { exact: false })).toBeVisible();
        await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
        await expect(source.getByRole('heading', { name: record.trackName, exact: true })).toBeVisible();
        const second = await fetch(`${base}/search-songs`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ lyrics: 'Second synthetic search fragment' }) });
        assert.equal(second.status, 200);
        await page.goto(`${ui}/#/historial`);
        await expect(page.locator('.data-table tbody tr')).toHaveCount(2);
        await expect(page.getByRole('checkbox')).toHaveCount(0);
        await expect(page.locator('.selection-toolbar')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Añadir a playlist', exact: true })).toHaveCount(0);
        // Nested history preview / playlist modal: close restores the preview.
        await page.locator('.data-table tbody tr').first().locator('.icon-action').first().click();
        await page.getByRole('dialog').locator('.song-card--source').getByRole('button', { name: 'Añadir a playlist', exact: true }).click();
        await expect(page.locator('[data-epic-modal]')).toHaveCount(2);
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-epic-modal]')).toHaveCount(1);
        await page.keyboard.press('Escape');
        for (const width of [320, 768, 1365]) {
            await page.setViewportSize({ width, height: 900 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `history list overflow at ${width}`);
            await page.goto(`${ui}/#/historial/${historyId}`);
            await expect(source.getByRole('heading', { name: record.trackName, exact: true })).toBeVisible();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `history detail overflow at ${width}`);
            if (process.env.UX_SCREENSHOTS) await page.screenshot({ path: `${process.env.UX_SCREENSHOTS}/history-source-${width}.png`, fullPage: true });
            await page.goto(`${ui}/#/historial`);
            await expect(page.getByRole('table')).toBeVisible();
        }
        assert.ok(!JSON.stringify(await SearchHistory.find({}).lean()).includes(fragment));
        assert.deepEqual(errors, []);
    } finally {
        await browser?.close(); await vite?.close();
        if (server) await new Promise(resolve => server.close(resolve));
        await mongoose.disconnect(); await mongo.stop();
    }
});
