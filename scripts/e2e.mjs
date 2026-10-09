// Local-only integration harness: actual Express/Mongoose/auth + isolated mongod.
// External AI/lyrics dependencies are injected; no runtime mock switch exists.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { chromium, expect } from '@playwright/test';
import { createServer } from '../../frontend-epic-music/node_modules/vite/dist/node/index.js';
import { createApp } from '../src/app.js';
import { searchSimilarSongs } from '../src/services/music.service.js';
import { Playlist } from '../src/models/playlist.model.js';
import { User } from '../src/models/user.model.js';
import { Artist } from '../src/models/artist.model.js';
import { SearchHistory } from '../src/models/search-history.model.js';
import { lookupLyrics } from '../src/services/lyrics.service.js';
import { Song } from '../src/models/song.model.js';
import { createSongCache, lrclibTransientDelivery } from '../src/services/song-cache.service.js';
import { analyzeLyricsEmotions } from '../src/services/emotions.service.js';
import { collectUX } from './ux-evidence.mjs';
import { auditAccessibility } from './ux-accessibility.mjs';
import { checkPolish } from './ux-polish.mjs';
import { checkMatrix } from './ux-matrix.mjs';

let mongo, server, vite, browser, base, ui;
const requests = [], pageErrors = [];
const fragment = 'Synthetic lyrics fragment for integration tests';
const fullLyricsFixture = 'Synthetic complete lyrics fixture\nSynthetic final line';
const cacheCounters = { externalLyricsCalls: 0, emotionAICalls: 0 };
const refetchFixtureCalls = new Map();
const mockLyricsFetch = async url => {
    cacheCounters.externalLyricsCalls++;
    const title = url.searchParams.get('track_name');
    if (title.startsWith('Refetch ')) {
        const calls = (refetchFixtureCalls.get(title) || 0) + 1;
        refetchFixtureCalls.set(title, calls);
        await new Promise(resolve => setTimeout(resolve, 100));
        if (title === 'Refetch Missing Fixture' && calls === 1) return new Response(null, { status: 404 });
    }
    return Response.json({ trackName: title, artistName: url.searchParams.get('artist_name'), plainLyrics: title.startsWith('Synthetic Song ') ? `Synthetic lyrics for ${title}\nSynthetic final line` : fullLyricsFixture, instrumental: false });
};
const mockEmotionAI = async () => { cacheCounters.emotionAICalls++; return { provider: 'fixture', model: 'emotion-fixture', content: JSON.stringify({ sufficientEvidence: true,
    emotions: [{ code: 'sadness', score: 50 }, { code: 'nostalgia', score: 30 }, { code: 'love', score: 20 }] }) }; };
const mockAI = async ({ messages, provider }) => {
    const data = JSON.parse(messages[1].content);
    await new Promise(resolve => setTimeout(resolve, 30));
    const incompleteFixture = data.lyrics?.includes('incomplete-artist-fixture');
    const learningFixture = data.lyrics?.includes('directory-learning-fixture');
    const sourceTitle = data.lyrics?.includes('transient-recovery') ? 'Transient Recovery Fixture' : data.lyrics?.includes('refetch-missing') ? 'Refetch Missing Fixture' : data.lyrics?.includes('refetch-restricted') ? 'Refetch Restricted Fixture' :
        data.lyrics?.includes('cache-acceptance') ? 'Cache Acceptance Source' : 'Synthetic Source';
    const incompleteMiss = incompleteFixture && data.artist !== 'Miranda!' && data.artistFragment !== 'Mirand';
    const content = data.lyrics?.includes('notfound') || incompleteMiss ? { found: false } : data.lyrics ?
        { found: true, confidence: learningFixture ? .85 : .9, song: { title: sourceTitle, artist: learningFixture ? 'Fresh Directory Artist' : incompleteFixture ? 'Miranda!' : data.lyrics.includes('global-learning') ? 'Global Fixture Artist' : 'Test Artist', genre: 'Test', album: 'Test Album', releaseYear: 2020 } } :
        { recommendations: Array.from({ length: 11 }, (_, i) => ({ title: `Synthetic Song ${i + 1}`, artist: 'Test Artist', genre: 'Test', reason: 'Synthetic instrumentation comparison' })) };
    return { provider, model: 'deterministic-test', content: JSON.stringify(content) };
};
before(async () => {
    process.env.JWT_SECRET = 'isolated-e2e-test-secret';
    process.env.MUSIC_ENABLE_FALLBACK = 'false';
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'epic_e2e_only' });
    await Promise.all([Playlist.init(), User.init(), Artist.init(), SearchHistory.init(), Song.init()]);
    server = createApp({ search: input => searchSimilarSongs(input, { callAI: mockAI }), lyrics: createSongCache({
        storagePolicy: data => ({ authorized: !['Refetch Restricted Fixture', 'Transient Recovery Fixture'].includes(data.title), reference: 'Own synthetic E2E fixture; injected transport only' }), metrics: cacheCounters,
        // Distinguish an explicit test delivery block from lack of storage permission.
        transientPolicy: data => data.title !== 'Refetch Restricted Fixture' && lrclibTransientDelivery(data),
        retryMs: 1000, // Short deterministic cooldown for UI tests, production remains 30s.
        lookup: (song, opts) => lookupLyrics(song, { ...opts, fetchImpl: mockLyricsFetch }),
        analyze: (song, opts) => analyzeLyricsEmotions(song, { ...opts, callAI: mockEmotionAI }),
    }) }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    process.env.VITE_API_URL = base;
    process.env.VITE_AI_TIMEOUT = '800';
    const root = process.env.UX_FRONTEND_ROOT || fileURLToPath(new URL('../../frontend-epic-music', import.meta.url));
    vite = await createServer({ root, server: { host: '127.0.0.1', port: 5173, strictPort: true }, logLevel: 'error' });
    await vite.listen();
    ui = 'http://127.0.0.1:5173';
    browser = await chromium.launch({ headless: true });
});
after(async () => {
    await browser?.close();
    await vite?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
    await mongo?.stop();
});
async function pageFor(width = 1280) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390 });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', req => { if (req.url().startsWith(base)) requests.push(new URL(req.url()).pathname); });
    await page.goto(ui);
    await expect(page.locator('#lyrics')).toBeVisible();
    return page;
}
async function register(page, suffix) {
    await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
    await page.getByLabel('Nombre para mostrar').fill(`Test ${suffix}`);
    await page.getByRole('textbox', { name: 'Nombre de usuario', exact: true }).fill(`e2e_${suffix}`);
    await page.getByRole('textbox', { name: 'Correo electrónico', exact: true }).fill(`${suffix}@example.test`);
    await page.getByLabel('Teléfono').fill(`12345${Array.from(suffix).reduce((sum, char) => sum + char.charCodeAt(0), 0)}`);
    await page.locator('#auth-password').fill('Test-only-Password123!');
    await page.getByRole('button', { name: 'Crear cuenta y entrar', exact: true }).click();
    await expect(page.getByLabel('Fragmento de letra')).toBeVisible();
}
async function login(page, suffix) {
    await page.getByRole('textbox', { name: 'Correo electrónico', exact: true }).fill(`${suffix}@example.test`);
    await page.locator('#auth-password').fill('Test-only-Password123!');
    await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
    await expect(page.getByLabel('Fragmento de letra')).toBeVisible();
}

async function openHints(page) {
    const details = page.locator('.discovery-hints');
    if (!await details.evaluate(el => el.open)) await details.locator('summary').click();
}

test('UX search: optional hints preserve values without automatic searches', async () => {
    const page = await pageFor(320);
    const count = requests.filter(p => p === '/search-songs').length;
    await expect(page.getByRole('button', {name:'Buscar canciones similares',exact:true})).toBeDisabled();
    await openHints(page);
    await page.getByLabel('Artista (opcional)').fill('Synthetic artist');
    await page.getByLabel('Género (opcional)').fill('Synthetic genre');
    await page.locator('.discovery-hints summary').click();
    await expect(page.locator('.discovery-hints summary')).toContainText('Synthetic artist');
    await expect(page.locator('.discovery-hints summary')).toContainText('Synthetic genre');
    await openHints(page);
    await expect(page.getByLabel('Artista (opcional)')).toHaveValue('Synthetic artist');
    await expect(page.getByLabel('Género (opcional)')).toHaveValue('Synthetic genre');
    assert.equal(requests.filter(p => p === '/search-songs').length,count);
    await page.context().close();
});

test('UX evidence: deterministic responsive audit', { skip: !process.env.UX_PHASE, timeout: 180000 }, async () => {
    const page = await pageFor();
    try { await collectUX({ page, ui, register, fragment }); }
    finally { await page.context().close(); }
});

test('UX accessibility: WCAG scans across themes, languages and presets', {skip:!process.env.UX_AXE,timeout:180000},async()=>{
    const page=await pageFor(390);
    try { await auditAccessibility({page,ui,fragment,register}); }
    finally { await page.context().close(); }
});

test('UX modal: long lyrics use one scroll area at small and landscape viewports', async () => {
    const page = await pageFor(320);
    await page.locator('#lyrics').fill(fragment);
    await page.getByRole('button', {name:'Buscar canciones similares',exact:true}).click();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    await page.route('**/songs/lyrics?*', async route => {
        const response = await route.fetch();
        if(!response.ok()) return route.fulfill({response});
        const json = await response.json();
        json.data.lyrics = 'Synthetic long line for responsive reading\n'.repeat(100);
        await route.fulfill({response, json});
    });
    for (const [width,height] of [[320,700],[844,390],[390,350]]) {
        await page.setViewportSize({width,height});
        const opener = page.locator('.song-card__open').first();
        await opener.click();
        await expect(page.locator('.lyrics-text')).toContainText('Synthetic long line');
        assert.equal(await page.locator('.lyrics-text').evaluate(el=>el.scrollHeight > el.clientHeight),false);
        assert.equal(await page.getByRole('dialog').locator('.modal__body').evaluate(el=>el.scrollHeight > el.clientHeight),true);
        const close = page.getByRole('button',{name:'Cerrar',exact:true});
        const box = await close.boundingBox();
        assert.ok(box.y >= 0 && box.y + box.height <= height);
        assert.ok(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth));
        await page.keyboard.press('Escape');
        await expect(opener).toBeFocused();
    }
    await page.context().close();
});

test('UX preferences: keyboard radios and honest low-contrast warning', async () => {
    const page=await pageFor(320);
    await page.goto(`${ui}/#/ajustes`);
    await page.getByRole('radio',{name:/^Oscuro/}).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('html')).toHaveAttribute('data-theme','light');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('html')).toHaveAttribute('data-theme','custom');
    await page.locator('#color-text').fill('#1a141d');
    await expect(page.locator('.contrast-note.is-warning')).toBeVisible();
    await page.getByRole('button',{name:'Epica',exact:true}).click();
    await expect(page.locator('.contrast-note.is-warning')).toHaveCount(0);
    await page.getByRole('radio',{name:'Español',exact:true}).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('html')).toHaveAttribute('lang','en');
    await page.context().close();
});

test('UX polish: skip link, motion, focus, reflow and interaction timing', {timeout:45000},async()=>{
    const page=await pageFor(390);
    try { await checkPolish({page,ui,fragment}); }
    finally { await page.context().close(); }
});

test('UX matrix: all viewports, themes, languages and long content', {skip:!process.env.UX_FULL,timeout:120000},async()=>{
    const page=await pageFor(390);
    try { await checkMatrix({page,ui,fragment}); }
    finally { await page.context().close(); }
});

test('UX profile: local demo editing and profile menu keyboard preserve context',async()=>{
    const page=await pageFor(320);
    await page.goto(`${ui}/#/login`);
    await page.getByRole('button',{name:'Entrar sin cuenta (demostración)',exact:true}).click();
    await page.goto(`${ui}/#/perfil`);
    await page.getByRole('button',{name:'Editar perfil',exact:true}).click();
    await expect(page.locator('#edit-display-name')).toBeFocused();
    await page.locator('#edit-display-name').fill('Synthetic Long Profile Name for UX Checks');
    await page.locator('#edit-bio').fill('Synthetic music preferences for local demo testing.');
    await page.getByRole('dialog').getByRole('button',{name:'Guardar cambios',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.profile__display-name')).toContainText('Synthetic Long Profile');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.getByRole('button',{name:'Abrir menú de perfil'}).click();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem',{name:'Perfil',exact:true})).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button',{name:'Abrir menú de perfil'})).toBeFocused();
    await page.context().close();
});

test('browser: explicit search → selection → login → persistent playlist and complete management', { timeout: 60000 }, async () => {
    const page = await pageFor();
    const beforeSearch = requests.filter(p => p === '/search-songs').length;
    await page.getByLabel('Fragmento de letra').fill(fragment);
    await page.waitForTimeout(350);
    assert.equal(requests.filter(p => p === '/search-songs').length, beforeSearch);
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    assert.equal(requests.filter(p => p === '/search-songs').length, beforeSearch + 1);
    await page.getByRole('checkbox').nth(0).check();
    await page.getByRole('checkbox').nth(1).check();
    await page.getByRole('checkbox').nth(2).check();
    await expect(page.getByText('3 canciones seleccionadas', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Inicia sesión para guardar playlists' }).click();
    await register(page, 'a');
    await expect(page.getByText('3 canciones seleccionadas', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Guardar selección', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Nombre de playlist', exact: true })).toBeFocused();
    await page.getByRole('textbox', { name: 'Nombre de playlist', exact: true }).fill('E2E playlist');
    await page.getByRole('button', { name: 'Crear con selección' }).dblclick();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal(await Playlist.countDocuments({ name: 'E2E playlist' }), 1);
    await page.getByRole('button', { name: 'Guardar selección', exact: true }).click();
    await page.getByRole('button', { name: 'Añadir a existente' }).click();
    await page.getByRole('dialog').getByRole('combobox').selectOption({ label: 'E2E playlist (3)' });
    await page.getByRole('button', { name: 'Añadir canciones', exact: true }).click();
    await expect(page.getByText('Guardado: 0 añadidas; 3 duplicadas omitidas.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Mis playlists', exact: true }).click();
    await page.getByRole('link', { name: 'E2E playlist', exact: true }).click();
    const detailUrl = page.url();
    await expect(page.locator('.playlist-songs > li')).toHaveCount(3);
    await page.reload();
    await expect(page.locator('.playlist-songs > li')).toHaveCount(3);
    await page.getByRole('button', { name: 'Editar playlist', exact: true }).click();
    await page.getByRole('textbox', { name: 'Nombre de playlist', exact: true }).fill('Renamed E2E');
    await page.getByLabel('Descripción (opcional)').fill('Persistent description');
    await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Renamed E2E', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Subir Synthetic Song 2', exact: true }).click();
    await expect(page.locator('.playlist-songs > li').nth(1)).toContainText('Synthetic Song 2');
    await page.getByRole('button', { name: 'Quitar Synthetic Song 1', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
    await expect(page.locator('.playlist-songs > li')).toHaveCount(2);
    await page.getByRole('button', { name: 'Eliminar playlist', exact: true }).click();
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(page.locator('.playlist-songs > li')).toHaveCount(2);
    await page.getByRole('button', { name: 'Abrir menú de perfil' }).click();
    await page.getByRole('menuitem', { name: /Cerrar sesión/ }).click();
    await expect(page.getByText('Inicia sesión para guardar playlists', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).last().click();
    await login(page, 'a');
    await page.goto(detailUrl);
    await expect(page.locator('.playlist-songs > li')).toHaveCount(2);
    await expect(page.getByText('Persistent description', { exact: true })).toBeVisible();
    const pageB = await pageFor();
    await pageB.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await register(pageB, 'b');
    await pageB.goto(detailUrl);
    await expect(pageB.getByText('El recurso no está disponible.', { exact: true })).toBeVisible();
    await expect(pageB.locator('.playlist-songs > li')).toHaveCount(0);
    await pageB.context().close();
    await page.getByRole('button', { name: 'Eliminar playlist', exact: true }).click();
    await page.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
    await expect(page.getByText('Todavía no tienes playlists.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Crear playlist', exact: true }).click();
    await page.getByRole('textbox', { name: 'Nombre de playlist', exact: true }).fill('Empty E2E');
    await page.getByRole('dialog').getByRole('button', { name: 'Crear playlist', exact: true }).click();
    await page.getByRole('link', { name: 'Empty E2E' }).click();
    await expect(page.getByText('Esta playlist está vacía.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Descubrir y añadir canciones' }).click();
    await page.getByLabel('Fragmento de letra').fill(fragment);
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    await page.getByRole('checkbox').first().check();
    await page.getByRole('button', { name: 'Guardar selección', exact: true }).click();
    await page.getByRole('button', { name: 'Añadir a existente' }).click();
    await page.getByRole('dialog').getByRole('combobox').selectOption({ label: 'Empty E2E (0)' });
    await page.getByRole('button', { name: 'Añadir canciones', exact: true }).click();
    await expect(page.getByText('Guardado: 1 añadidas; 0 duplicadas omitidas.', { exact: true })).toBeVisible();
    assert.equal(await Playlist.countDocuments({ name: 'Renamed E2E' }), 0);
    assert.ok(!requests.some(p => p === '/songs' || p === '/recommend'));
    assert.deepEqual(pageErrors, []);
    await page.context().close();
});

test('browser regression: es/en, dark/light/custom, focus, health, expired session', { timeout: 45000 }, async () => {
    const page = await pageFor(390);
    await page.goto(`${ui}/#/ajustes`);
    for (const [label, value] of [['Claro', 'light'], ['Personalizado', 'custom'], ['Oscuro', 'dark']]) {
        await page.getByRole('radio', { name: new RegExp(`^${label}`) }).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', value);
        await page.getByRole('button', { name: 'Buscar', exact: true }).click();
        const colors = await page.getByLabel('Fragmento de letra').evaluate(element => {
            const style = getComputedStyle(element);
            return { text: style.color, background: style.backgroundColor };
        });
        assert.notEqual(colors.text, colors.background);
        assert.notEqual(colors.background, 'rgba(0, 0, 0, 0)');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.goto(`${ui}/#/ajustes`);
    }
    await page.getByRole('button', { name: 'Comprobar conexión' }).click();
    await expect(page.getByText('API y MongoDB conectados (no comprueba proveedores IA)', { exact: true })).toBeVisible();
    await page.getByRole('radio', { name: 'English', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByLabel('Lyrics fragment')).toBeVisible();
    await page.getByRole('button', { name: 'My playlists', exact: true }).click();
    await expect(page.getByText('Sign in to save playlists', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'My playlists' })).toBeVisible();
    await page.goto(`${ui}/#/ajustes`);
    await page.getByRole('radio', { name: 'Español', exact: true }).click();
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await login(page, 'a');
    await page.getByRole('button', { name: 'Mis playlists', exact: true }).click();
    await page.getByRole('button', { name: 'Crear playlist', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Nombre de playlist', exact: true })).toBeFocused();
    await page.getByRole('textbox', { name: 'Nombre de playlist', exact: true }).fill('Never committed');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Crear playlist', exact: true })).toBeFocused();
    await page.route('**/playlists', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'expired' } }) }));
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await page.getByRole('button', { name: 'Mis playlists', exact: true }).click();
    await expect(page.getByText('Inicia sesión para guardar playlists', { exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => localStorage.getItem('me:token') === null), true);
    await expect(page.getByRole('button', { name: 'Crear playlist', exact: true })).toHaveCount(0);
    assert.equal(await Playlist.countDocuments({ name: 'Never committed' }), 0);
    assert.deepEqual(pageErrors, []);
    await page.context().close();
});

test('browser mobile: demo privacy, selection reset, found:false, errors and cancellation', { timeout: 45000 }, async () => {
    const page = await pageFor(390);
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await page.getByRole('button', { name: 'Entrar sin cuenta (demostración)' }).click();
    const historyBefore = requests.filter(p => p.startsWith('/search-history')).length;
    await page.getByRole('button', { name: 'Historial', exact: true }).click();
    await expect(page.getByText(/Historial local de este navegador/)).toBeVisible();
    assert.equal(requests.filter(p => p.startsWith('/search-history')).length, historyBefore);
    const privateBefore = requests.filter(p => p.startsWith('/playlists')).length;
    await page.getByRole('button', { name: 'Mis playlists', exact: true }).click();
    await expect(page.getByText('Inicia sesión para guardar playlists', { exact: true })).toBeVisible();
    assert.equal(requests.filter(p => p.startsWith('/playlists')).length, privateBefore);
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await page.getByLabel('Fragmento de letra').fill(fragment);
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    await page.getByRole('button', { name: 'Seleccionar todas las recomendaciones' }).click();
    await expect(page.getByText('11 canciones seleccionadas', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Limpiar selección' }).click();
    await expect(page.getByText('0 canciones seleccionadas', { exact: true })).toBeVisible();
    await page.getByRole('checkbox').first().focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('checkbox').first()).toBeChecked();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByLabel('Fragmento de letra').fill('notfound synthetic fragment for tests');
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByText(/No se identificó la canción/)).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await page.route('**/search-songs', route => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'provider failed' }) }));
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('La IA no pudo');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('me:guest-search-history:v1'))[0].errorCode), 'PROVIDER_ERROR');
    await page.unroute('**/search-songs');
    await page.route('**/search-songs', async route => { await new Promise(resolve => setTimeout(resolve, 1500)); await route.abort().catch(() => {}); });
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Se agotó el tiempo');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('me:guest-search-history:v1'))[0].errorCode), 'TIMEOUT');
    const storedBeforeCancel = await page.evaluate(() => JSON.parse(localStorage.getItem('me:guest-search-history:v1')).length);
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('me:guest-search-history:v1')).length), storedBeforeCancel);
    await page.context().close();
});

test('search intelligence UI: accessible global autocomplete, corrections, ambiguity and stale requests', { timeout: 45000 }, async () => {
    await Artist.create(['Mindless Self Indulgence', 'Muse', 'Musa'].map(canonicalName => ({ canonicalName, validationStatus: 'curated', source: 'curation' })));
    const page = await pageFor(390);
    await openHints(page);
    const artist = page.getByRole('combobox', { name: 'Artista (opcional)' });
    const searchesBefore = requests.filter(p => p === '/search-songs').length;
    const suggestionsBefore = requests.filter(p => p === '/artists/suggest').length;
    await artist.pressSequentially('Mind', { delay: 30 });
    await expect(page.getByRole('option')).toContainText(['Mindless Self Indulgence']);
    assert.equal(requests.filter(p => p === '/artists/suggest').length, suggestionsBefore + 1);
    assert.equal(requests.filter(p => p === '/search-songs').length, searchesBefore);
    await artist.press('ArrowDown');
    await expect(artist).toHaveAttribute('aria-activedescendant', /option-0$/);
    await expect(page.getByRole('option')).toHaveAttribute('aria-selected', 'true');
    await artist.press('Enter'); await expect(artist).toHaveValue('Mindless Self Indulgence');
    await expect(artist).toBeFocused(); await expect(artist).toHaveAttribute('aria-expanded', 'false');
    await artist.fill('Mindles Self Indulgence');
    await page.getByLabel('Género (opcional)').fill('symphonic mettal');
    await page.getByLabel('Fragmento de letra').fill(fragment);
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    await expect(page.getByText('Corrección aplicada.', { exact: true })).toHaveCount(2);
    await expect(page.getByLabel('Resolución de pistas')).toContainText('Symphonic Metal');
    await artist.fill('Musi');
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Usar Muse', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Usar Muse', exact: true }).tap();
    await expect(artist).toHaveValue('Muse');
    const searchesAfter = requests.filter(p => p === '/search-songs').length;
    await page.route('**/artists/suggest?*', async route => {
        const q = new URL(route.request().url()).searchParams.get('q');
        await new Promise(r => setTimeout(r, q === 'Old' ? 700 : 20));
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { artists: [{ id: q, canonicalName: `${q} fixture`, validationStatus: 'model_inferred' }] } }) }).catch(() => {});
    });
    await artist.fill('Old'); await page.waitForTimeout(300); await artist.fill('New');
    await expect(page.getByRole('option')).toContainText(['New fixture']);
    await page.waitForTimeout(500); await expect(page.getByRole('option')).toContainText(['New fixture']);
    await artist.press('Escape'); await expect(artist).toHaveAttribute('aria-expanded', 'false');
    await artist.press('ArrowDown'); await expect(artist).toHaveAttribute('aria-expanded', 'true');
    await artist.press('Tab'); await expect(artist).toHaveAttribute('aria-expanded', 'false');
    await page.unroute('**/artists/suggest?*');
    await page.route('**/artists/suggest?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'UNAVAILABLE' } }) }));
    await artist.fill('Offline'); await expect(page.getByText('Sugerencias no disponibles. Puedes seguir escribiendo y buscar.')).toBeVisible();
    await artist.fill('Still editable'); await expect(artist).toHaveValue('Still editable');
    assert.equal(requests.filter(p => p === '/search-songs').length, searchesAfter);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(pageErrors, []);
    await page.context().close();
});

test('history UI guest: local reload, saved recommendations, navigation, deletion and storage failure', { timeout: 45000 }, async () => {
    const page = await pageFor(390);
    await page.getByRole('button', { name: 'Historial', exact: true }).click();
    await expect(page.getByText('Todavía no hay búsquedas en este historial.')).toBeVisible();
    await expect(page.getByText(/Historial local de este navegador/)).toBeVisible();
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await page.getByLabel('Fragmento de letra').fill(fragment);
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).dblclick();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    await page.getByRole('checkbox').first().check();
    await expect(page.getByText('Búsqueda guardada solo en este navegador.')).toBeVisible();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('me:guest-search-history:v1')).length), 1);
    assert.equal(await page.evaluate(value => localStorage.getItem('me:guest-search-history:v1').includes(value), fragment), false);
    await page.getByRole('link', { name: 'Ver resultado guardado' }).click();
    await expect(page.locator('.song-card')).toHaveCount(12);
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    await expect(page.getByRole('checkbox').first()).toBeChecked();
    await page.getByRole('button', { name: 'Historial', exact: true }).click();
    await page.reload();
    await expect(page.locator('.history-table tbody tr')).toHaveCount(1);
    await page.getByRole('link', { name: 'Synthetic Source — Test Artist', exact: true }).click();
    await expect(page.locator('.song-card')).toHaveCount(12);
    await page.getByRole('button', { name: 'Eliminar entrada', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
    await expect(page.getByText('Todavía no hay búsquedas en este historial.')).toBeVisible();
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await page.getByLabel('Fragmento de letra').fill('notfound synthetic history fragment');
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByText(/No se identificó la canción/)).toBeVisible();
    await page.getByRole('button', { name: 'Historial', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Sin identificar', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) { if (key === 'me:guest-search-history:v1') throw new DOMException('fixture', 'QuotaExceededError'); return original.call(this, key, value); };
    });
    await page.getByLabel('Fragmento de letra').fill(fragment);
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    await expect(page.getByText(/No se pudo guardar o leer el historial local/)).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.context().close();
});

test('history UI account: JWT persistence, global artist A/B/guest, logout and private detail isolation', { timeout: 45000 }, async () => {
    const page = await pageFor();
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await register(page, 'historya');
    await page.getByLabel('Fragmento de letra').fill('global-learning synthetic fragment for history');
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByText('Búsqueda guardada en el historial de tu cuenta.')).toBeVisible();
    assert.equal(await page.evaluate(() => localStorage.getItem('me:guest-search-history:v1')), null);
    await page.getByRole('link', { name: 'Ver resultado guardado' }).click();
    const detailUrl = page.url();
    await expect(page.locator('.song-card')).toHaveCount(12);
    await page.reload(); await expect(page.locator('.song-card')).toHaveCount(12);
    const other = await pageFor(390);
    await openHints(other);
    await other.getByLabel('Artista (opcional)').fill('Global');
    await expect(other.getByRole('option')).toContainText(['Global Fixture Artist']);
    await other.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await register(other, 'historyb');
    await other.getByRole('button', { name: 'Historial', exact: true }).click();
    await expect(other.getByText('Todavía no hay búsquedas en este historial.')).toBeVisible();
    await other.goto(detailUrl);
    await expect(other.getByRole('alert')).toContainText('El recurso no está disponible.');
    await expect(other.locator('.song-card')).toHaveCount(0);
    await other.getByRole('button', { name: 'Buscar', exact: true }).click();
    await openHints(other);
    await other.getByLabel('Artista (opcional)').fill('Global');
    await expect(other.getByRole('option')).toContainText(['Global Fixture Artist']);
    await other.context().close();
    await page.getByRole('button', { name: 'Abrir menú de perfil' }).click();
    await page.getByRole('menuitem', { name: /Cerrar sesión/ }).click();
    await expect(page.locator('.song-card')).toHaveCount(0);
    await page.getByRole('button', { name: 'Historial', exact: true }).click();
    await expect(page.getByText(/Historial local de este navegador/)).toBeVisible();
    await expect(page.getByText('Todavía no hay búsquedas en este historial.')).toBeVisible();
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await login(page, 'historya');
    await page.goto(detailUrl); await expect(page.locator('.song-card')).toHaveCount(12);
    assert.deepEqual(pageErrors, []);
    await page.context().close();
});

test('history hardening UI: ES/EN, all themes, desktop/mobile, unavailable history and no extra AI calls', { timeout: 60000 }, async () => {
    const page = await pageFor(390);
    await page.getByLabel('Fragmento de letra').fill(fragment);
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    const searchCount = requests.filter(p => p === '/search-songs').length;
    const historyId = await page.evaluate(() => JSON.parse(localStorage.getItem('me:guest-search-history:v1'))[0].id);
    for (const width of [390, 1280]) for (const language of ['es', 'en']) for (const [index, theme] of ['dark', 'light', 'custom'].entries()) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.goto(`${ui}/#/ajustes`);
        await page.getByRole('radio', { name: language === 'es' ? 'Español' : 'English', exact: true }).click();
        await page.locator('.theme-option').nth(index).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.locator('html')).toHaveAttribute('lang', language);
        await page.goto(`${ui}/#/historial`);
        await expect(page.locator('.history-table tbody tr')).toHaveCount(1);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.getByRole('button', { name: `${language === 'es' ? 'Ver' : 'View'} Synthetic Source — Test Artist`, exact: true }).click();
        await expect(page.getByRole('dialog').locator('.song-card')).toHaveCount(12);
        assert.ok(await page.getByRole('dialog').locator('.modal__body').evaluate(element => element.scrollWidth <= element.clientWidth));
        await page.keyboard.press('Escape');
        await page.goto(`${ui}/#/historial/${historyId}`);
        await expect(page.locator('.song-card')).toHaveCount(12);
        const colors = await page.locator('.history-page .card').first().evaluate(element => ({ text: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
        assert.notEqual(colors.text, colors.background);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.getByRole('button', { name: language === 'es' ? 'Buscar' : 'Search', exact: true }).click();
        await openHints(page);
        const artist = page.getByRole('combobox', { name: language === 'es' ? 'Artista (opcional)' : 'Artist (optional)' });
        await artist.fill('Test');
        await expect(page.getByRole('option').first()).toContainText('Test Artist');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await artist.press('Escape');
    }
    assert.equal(requests.filter(p => p === '/search-songs').length, searchCount);
    await page.goto(`${ui}/#/ajustes`); await page.getByRole('radio', { name: 'Español', exact: true }).click();
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await register(page, 'hardening');
    await page.route('**/search-history?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'UNAVAILABLE' } }) }));
    await page.getByRole('button', { name: 'Historial', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('El servicio no está disponible.');
    await page.unroute('**/search-history?*');
    await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
    await expect(page.getByText('Todavía no hay búsquedas en este historial.')).toBeVisible();
    const owner = await User.findOne({ username: 'e2e_hardening' });
    await SearchHistory.insertMany(Array.from({ length: 21 }, (_, index) => ({
        owner: owner._id, requestId: `pagination-fixture-${index}`, status: 'not_found',
        input: { original: { artist: `Page fixture ${index}` }, resolved: { artist: `Page fixture ${index}` } },
        result: { found: false, song: null, recommendations: [], count: 0 }, expiresAt: new Date(Date.now() + 86400000),
    })));
    await page.getByRole('button', { name: 'Actualizar historial', exact: true }).click();
    await expect(page.locator('.history-table tbody tr')).toHaveCount(20);
    await page.getByRole('button', { name: 'Cargar más', exact: true }).dblclick();
    await expect(page.locator('.history-table tbody tr')).toHaveCount(21);
    await expect(page.getByRole('button', { name: 'Cargar más', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await page.route('**/search-songs', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { found: false, song: null, recommendations: [], count: 0, history: { status: 'unavailable', id: null } } }) }));
    await page.getByLabel('Fragmento de letra').fill(fragment);
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByText('El resultado está disponible, pero no se pudo confirmar el guardado en el historial.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ver resultado guardado' })).toHaveCount(0);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('me:guest-search-history:v1')).length), 1);
    assert.deepEqual(pageErrors, []);
    await page.context().close();
});

test('incomplete artist UI: canonical prefix succeeds and competing completions remain explicit', { timeout: 30000 }, async () => {
    await Artist.create({ canonicalName: 'Miranda!', validationStatus: 'curated', source: 'curation' });
    const page = await pageFor(390);
    await openHints(page);
    const artist = page.getByRole('combobox', { name: 'Artista (opcional)' });
    await page.getByLabel('Fragmento de letra').fill('incomplete-artist-fixture synthetic fragment');
    await artist.fill('Mirand');
    let response = page.waitForResponse(res => res.url() === `${base}/search-songs`);
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    let result = await response;
    assert.equal(result.status(), 200);
    let data = (await result.json()).data;
    assert.equal(data.input.resolved.artist, 'Miranda!'); assert.equal(data.ai.callCount, 2);
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    await expect(page.getByLabel('Resolución de pistas')).toContainText('Mirand → Miranda!');
    await expect(page.getByText('Corrección aplicada.', { exact: true })).toHaveCount(1);
    await Artist.create({ canonicalName: 'Miranda Lambert', validationStatus: 'curated', source: 'curation' });
    response = page.waitForResponse(res => res.url() === `${base}/search-songs`);
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    result = await response; data = (await result.json()).data;
    assert.equal(result.status(), 200); assert.equal(data.input.resolved.artist, 'Mirand');
    assert.equal(data.input.needsConfirmation, true); assert.equal(data.ai.callCount, 3);
    await expect(page.getByRole('button', { name: 'Usar Miranda!', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Usar Miranda Lambert', exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(pageErrors, []);
    await page.context().close();
});

test('artist persistence UI: an exact identified hint refreshes empty suggestions and is selectable immediately', { timeout: 30000 }, async () => {
    const page = await pageFor(390), visitor = await pageFor();
    await openHints(page); await openHints(visitor);
    const artist = page.getByRole('combobox', { name: 'Artista (opcional)' });
    const otherArtist = visitor.getByRole('combobox', { name: 'Artista (opcional)' });
    await otherArtist.fill('Fresh Directory');
    await expect(visitor.getByText('Sin sugerencias. Puedes escribir cualquier artista.')).toBeVisible();
    await visitor.getByLabel('Fragmento de letra').click();
    await artist.fill('Fresh Directory Artist');
    await expect(page.getByText('Sin sugerencias. Puedes escribir cualquier artista.')).toBeVisible();
    await page.getByLabel('Fragmento de letra').fill('directory-learning-fixture synthetic fragment');
    const beforeSuggestions = requests.filter(path => path === '/artists/suggest').length;
    const beforeSearches = requests.filter(path => path === '/search-songs').length;
    const pending = page.waitForResponse(res => res.url() === `${base}/search-songs`);
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    const reply = await pending, data = (await reply.json()).data;
    assert.equal(reply.status(), 200); assert.equal(data.song.modelConfidence, .85);
    assert.equal(data.directory.status, 'saved');
    assert.equal(await Artist.countDocuments({ canonicalName: 'Fresh Directory Artist' }), 1);
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    // A new GET is automatic even while the artist field is blurred/unchanged.
    await expect.poll(() => requests.filter(path => path === '/artists/suggest').length).toBeGreaterThan(beforeSuggestions);
    await artist.focus();
    await expect(page.getByRole('option')).toContainText(['Fresh Directory Artist']);
    await artist.press('ArrowDown'); await artist.press('Enter');
    await expect(artist).toHaveValue('Fresh Directory Artist');
    await expect(artist).toHaveAttribute('aria-expanded', 'false');
    // A different visitor rechecks the same previously empty query on focus.
    await otherArtist.focus();
    await expect(visitor.getByRole('option')).toContainText(['Fresh Directory Artist']);
    await visitor.getByRole('option').click();
    await expect(otherArtist).toHaveValue('Fresh Directory Artist');
    assert.equal(requests.filter(path => path === '/search-songs').length, beforeSearches + 1);
    await page.route('**/search-songs', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { ...data, directory: { status: 'unavailable' } } }) }));
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    await expect(page.getByText('El resultado está disponible, pero no se pudo guardar el artista en el directorio. Puede que todavía no aparezca en las sugerencias.')).toBeVisible();
    assert.deepEqual(pageErrors, []);
    await visitor.context().close(); await page.context().close();
});

test('music details UI: search links, full external lyrics, guest history preview and confirmed deletion', { timeout: 45000 }, async () => {
    const page = await pageFor(390);
    const beforeLyrics = requests.filter(path => path === '/songs/lyrics').length;
    await page.getByLabel('Fragmento de letra').fill(fragment);
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    await expect(page.locator('.song-links a')).toHaveCount(36);
    const source = page.locator('.song-card').first();
    const youtube = source.getByRole('link', { name: /en YouTube/ });
    assert.equal(new URL(await youtube.getAttribute('href')).searchParams.get('search_query'), 'Synthetic Source Test Artist');
    await expect(youtube).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(source.getByRole('link', { name: /en Spotify/ })).toHaveAttribute('href', /open\.spotify\.com\/search\//);
    await expect(source.getByRole('link', { name: /en Apple Music/ })).toHaveAttribute('href', /music\.apple\.com\/us\/search/);
    assert.equal(requests.filter(path => path === '/songs/lyrics').length, beforeLyrics);
    await source.getByRole('button', { name: 'Ver letra completa' }).click();
    await expect(source.locator('.lyrics-text')).toHaveText(fullLyricsFixture);
    assert.equal(await page.evaluate(text => localStorage.getItem('me:guest-search-history:v1').includes(text), fullLyricsFixture), false);
    await source.getByRole('button', { name: 'Ocultar letra' }).click();
    await expect(page.locator('.lyrics-text')).toHaveCount(0);
    const reopenRequests = requests.filter(path => path === '/songs/lyrics').length;
    const reopenCounters = { ...cacheCounters };
    await source.getByRole('button', { name: 'Ver letra completa' }).click();
    await expect(source.locator('.lyrics-text')).toHaveText(fullLyricsFixture);
    assert.equal(requests.filter(path => path === '/songs/lyrics').length, reopenRequests);
    assert.deepEqual(cacheCounters, reopenCounters);
    await source.getByRole('button', { name: 'Ocultar letra' }).click();
    // Explicitly reset client memory only for synthetic error-state injection.
    await page.evaluate(async () => (await import('/src/services/lyrics.js')).clearLyricsMemory());
    await page.route('**/songs/lyrics?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { status: 'not_found', lyrics: null } }) }));
    await source.getByRole('button', { name: 'Ver letra completa' }).click();
    await expect(source.getByText('No hay una letra completa disponible para esta canción en la fuente consultada.')).toBeVisible();
    await source.getByRole('button', { name: 'Ocultar letra' }).click();
    await page.unroute('**/songs/lyrics?*');
    await page.evaluate(async () => (await import('/src/services/lyrics.js')).clearLyricsMemory());
    await page.route('**/songs/lyrics?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'LYRICS_UNAVAILABLE' } }) }));
    await source.getByRole('button', { name: 'Ver letra completa' }).click();
    await expect(source.getByRole('alert')).toContainText('No se pudo consultar la letra.');
    await page.unroute('**/songs/lyrics?*');
    await source.getByRole('button', { name: 'Reintentar', exact: true }).click();
    await expect(source.locator('.lyrics-text')).toHaveText(fullLyricsFixture);
    await source.getByRole('button', { name: 'Ocultar letra' }).click();
    await page.evaluate(async () => (await import('/src/services/lyrics.js')).clearLyricsMemory());
    await page.route('**/songs/lyrics?*', async route => {
        await new Promise(resolve => setTimeout(resolve, 300));
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { status: 'available', lyrics: fullLyricsFixture } }) }).catch(() => {});
    });
    const pendingLyrics = page.waitForRequest(request => new URL(request.url()).pathname === '/songs/lyrics');
    await source.getByRole('button', { name: 'Ver letra completa' }).click(); await pendingLyrics;
    await source.getByRole('button', { name: 'Ocultar letra' }).click();
    await page.waitForTimeout(400);
    await expect(source.locator('.lyrics-text')).toHaveCount(0); await expect(source.getByRole('alert')).toHaveCount(0);
    await page.unroute('**/songs/lyrics?*');
    await page.getByRole('button', { name: 'Historial', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Historial' })).toBeVisible();
    const listUrl = page.url();
    const eye = page.getByRole('button', { name: 'Ver Synthetic Source — Test Artist', exact: true });
    await eye.click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.locator('.song-card')).toHaveCount(12);
    await expect(dialog).toBeFocused();
    assert.equal(page.url(), listUrl);
    assert.equal(await page.locator('#root').evaluate(element => element.inert), true);
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Abrir detalle' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cerrar', exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: 'Ver letra completa' }).click();
    await expect(dialog.locator('.lyrics-text')).toHaveText(fullLyricsFixture);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0); await expect(eye).toBeFocused();
    assert.equal(await page.locator('#root').evaluate(element => element.inert), false);
    await page.getByRole('searchbox', { name: 'Filtrar Historial' }).fill('no fixture match');
    await expect(page.getByText('No hay coincidencias con este filtro.')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Filtrar Historial' }).fill('');
    await page.getByRole('button', { name: 'Ordenar por Fecha' }).click();
    await expect(page.getByRole('columnheader', { name: /Fecha/ })).toHaveAttribute('aria-sort', 'ascending');
    const remove = page.getByRole('button', { name: 'Eliminar Synthetic Source — Test Artist', exact: true });
    await remove.click(); dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Cancelar', exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(page.locator('.history-table tbody tr')).toHaveCount(1); await expect(remove).toBeFocused();
    await remove.click(); await page.getByRole('dialog').getByRole('button', { name: 'Confirmar eliminación' }).dblclick();
    await expect(page.getByText('Todavía no hay búsquedas en este historial.')).toBeVisible();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('me:guest-search-history:v1')).length), 0);
    assert.deepEqual(pageErrors, []);
    await page.context().close();
});

test('shared tables UI: playlist preview/filter/sort, delete failure/cancel/confirm and private history actions', { timeout: 60000 }, async () => {
    const page = await pageFor();
    const deletes = [];
    page.on('request', request => { if (request.method() === 'DELETE') deletes.push(new URL(request.url()).pathname); });
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click(); await register(page, 'tables');
    await page.getByLabel('Fragmento de letra').fill(fragment);
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    await page.getByRole('checkbox').nth(0).check(); await page.getByRole('checkbox').nth(1).check();
    await page.getByRole('button', { name: 'Guardar selección', exact: true }).click();
    await page.getByRole('textbox', { name: 'Nombre de playlist', exact: true }).fill('Zeta Fixture Playlist');
    await page.getByRole('button', { name: 'Crear con selección', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Mis playlists', exact: true }).click();
    await page.getByRole('button', { name: 'Crear playlist', exact: true }).click();
    await page.getByRole('textbox', { name: 'Nombre de playlist', exact: true }).fill('Álbum Fixture Playlist');
    await page.getByRole('dialog').getByRole('button', { name: 'Crear playlist', exact: true }).click();
    await expect(page.locator('.playlists-table tbody tr')).toHaveCount(2);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const language of ['es', 'en']) for (const [index, theme] of ['dark', 'light', 'custom'].entries()) {
        await page.goto(`${ui}/#/ajustes`);
        await page.getByRole('radio', { name: language === 'es' ? 'Español' : 'English', exact: true }).click();
        await page.locator('.theme-option').nth(index).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.getByRole('button', { name: language === 'es' ? 'Mis playlists' : 'My playlists', exact: true }).click();
        await expect(page.locator('.playlists-table tbody tr')).toHaveCount(2);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.getByRole('button', { name: `${language === 'es' ? 'Ver' : 'View'} Zeta Fixture Playlist`, exact: true }).click();
        await expect(page.getByRole('dialog').locator('.song-card')).toHaveCount(2);
        assert.ok(await page.getByRole('dialog').locator('.modal__body').evaluate(element => element.scrollWidth <= element.clientWidth));
        await page.keyboard.press('Escape');
    }
    await page.goto(`${ui}/#/ajustes`); await page.getByRole('radio', { name: 'Español', exact: true }).click();
    await page.getByRole('button', { name: 'Mis playlists', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: 'Ordenar por Nombre de playlist' }).click();
    await expect(page.locator('.playlists-table tbody tr').first()).toContainText('Álbum Fixture Playlist');
    await page.getByRole('searchbox', { name: 'Filtrar Mis playlists' }).fill('album');
    await expect(page.locator('.playlists-table tbody tr')).toHaveCount(1);
    await page.getByRole('searchbox', { name: 'Filtrar Mis playlists' }).fill('');
    const listUrl = page.url();
    const eye = page.getByRole('button', { name: 'Ver Zeta Fixture Playlist', exact: true });
    await eye.click();
    await expect(page.getByRole('dialog').locator('.song-card')).toHaveCount(2);
    await expect(page.getByRole('dialog').locator('.song-links a')).toHaveCount(6);
    assert.equal(page.url(), listUrl);
    await page.getByRole('dialog').getByRole('button', { name: 'Ver letra de Synthetic Song 1, de Test Artist', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Synthetic Song 1', exact: true }).locator('.lyrics-text')).toContainText('Synthetic lyrics for Synthetic Song 1');
    await expect(page.getByRole('dialog').getByRole('meter')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Zeta Fixture Playlist', exact: true }).locator('.song-card')).toHaveCount(2);
    await page.keyboard.press('Escape'); await expect(eye).toBeFocused();
    const remove = page.getByRole('button', { name: 'Eliminar Zeta Fixture Playlist', exact: true });
    await remove.click(); await page.getByRole('dialog').getByRole('button', { name: 'Cancelar', exact: true }).click();
    assert.equal(deletes.length, 0); assert.equal(await Playlist.countDocuments({ name: 'Zeta Fixture Playlist' }), 1);
    await page.route('**/playlists/*', route => route.request().method() === 'DELETE' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'UNAVAILABLE' } }) }) : route.continue());
    await remove.click(); await page.getByRole('dialog').getByRole('button', { name: 'Confirmar eliminación' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('El servicio no está disponible.');
    assert.equal(await Playlist.countDocuments({ name: 'Zeta Fixture Playlist' }), 1);
    await page.unroute('**/playlists/*');
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar eliminación' }).dblclick();
    await expect(page.locator('.playlists-table tbody tr')).toHaveCount(1);
    assert.equal(deletes.length, 2); assert.equal(await Playlist.countDocuments({ name: 'Zeta Fixture Playlist' }), 0);
    await page.getByRole('button', { name: 'Historial', exact: true }).click();
    await expect(page.locator('.history-table tbody tr')).toHaveCount(1);
    const historyId = await page.locator('.history-table tbody tr').getAttribute('data-row-id');
    await page.getByRole('button', { name: 'Ver Synthetic Source — Test Artist', exact: true }).click();
    await expect(page.getByRole('dialog').locator('.song-card')).toHaveCount(12);
    await page.getByRole('dialog').getByRole('button', { name: 'Ver letra completa' }).click();
    await expect(page.getByRole('dialog').locator('.lyrics-text')).toHaveText(fullLyricsFixture);
    assert.ok(!JSON.stringify(await SearchHistory.findById(historyId).lean()).includes(fullLyricsFixture));
    await page.getByRole('dialog').getByRole('button', { name: 'Ver letra de Synthetic Song 1, de Test Artist', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Synthetic Song 1', exact: true }).locator('.lyrics-text')).toContainText('Synthetic lyrics for Synthetic Song 1');
    await page.evaluate(() => { localStorage.removeItem('me:token'); window.dispatchEvent(new Event('auth:expired')); });
    await expect(page.locator('[data-epic-modal]')).toHaveCount(0);
    assert.equal(await page.locator('#root').evaluate(element => element.inert), false);
    assert.equal(await page.evaluate(() => document.body.style.overflow), '');
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click(); await login(page, 'tables');
    await page.getByRole('button', { name: 'Historial', exact: true }).click();
    await expect(page.locator('.history-table tbody tr')).toHaveCount(1);
    await page.getByRole('button', { name: 'Eliminar Synthetic Source — Test Artist', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancelar', exact: true }).click();
    assert.equal(deletes.length, 2);
    await page.getByRole('button', { name: 'Eliminar Synthetic Source — Test Artist', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar eliminación' }).dblclick();
    await expect(page.getByText('Todavía no hay búsquedas en este historial.')).toBeVisible();
    assert.equal(deletes.filter(path => path.startsWith('/search-history/')).length, 1);
    assert.equal(await SearchHistory.countDocuments({ _id: historyId }), 0);
    await page.getByRole('button', { name: 'Mis playlists', exact: true }).click();
    await page.getByRole('button', { name: 'Ver Álbum Fixture Playlist', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.evaluate(() => { localStorage.removeItem('me:token'); window.dispatchEvent(new Event('auth:expired')); });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Inicia sesión para guardar playlists', { exact: true })).toBeVisible();
    assert.equal(await page.locator('#root').evaluate(element => element.inert), false);
    assert.deepEqual(pageErrors, []);
    await page.context().close();
});

test('recommendation lyrics UI: card/keyboard opens lyrics plus three emotions in one request without changing selection', { timeout: 45000 }, async () => {
    const page = await pageFor(390);
    await page.getByLabel('Fragmento de letra').fill(fragment);
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    const lyricsBefore = requests.filter(path => path === '/songs/lyrics').length;
    const searches = requests.filter(path => path === '/search-songs').length;
    const first = page.locator('.recommendations__item').nth(0);
    const second = page.locator('.recommendations__item').nth(1);
    await first.locator('summary').click();
    await expect(first.locator('.song-reason')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal(requests.filter(path => path === '/songs/lyrics').length, lyricsBefore);
    await first.locator('summary').click();
    await first.getByRole('checkbox').check();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal(requests.filter(path => path === '/songs/lyrics').length, lyricsBefore);
    await page.context().route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Synthetic platform destination</p>' }));
    const [popup] = await Promise.all([page.waitForEvent('popup'), first.getByRole('link', { name: /en YouTube/ }).click()]);
    await popup.close();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal(requests.filter(path => path === '/songs/lyrics').length, lyricsBefore);
    const opener = first.getByRole('button', { name: 'Ver letra de Synthetic Song 1, de Test Artist', exact: true });
    await opener.focus();
    const response = page.waitForResponse(res => new URL(res.url()).pathname === '/songs/lyrics' && res.status() === 200);
    await page.keyboard.press('Enter');
    const { data } = await (await response).json();
    assert.equal(data.title, 'Synthetic Song 1'); assert.equal(data.artist, 'Test Artist');
    assert.equal(data.emotions.length, 3); assert.equal(data.emotionAnalysis.status, 'estimated');
    let dialog = page.getByRole('dialog', { name: 'Synthetic Song 1', exact: true });
    await expect(dialog.locator('.lyrics-text')).toHaveText('Synthetic lyrics for Synthetic Song 1\nSynthetic final line');
    await expect(dialog.getByRole('meter')).toHaveCount(3);
    await expect(dialog.getByRole('meter', { name: 'Tristeza', exact: true })).toHaveAttribute('aria-valuenow', '50');
    await expect(dialog.getByText(/Pesos relativos/)).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.keyboard.press('Escape'); await expect(opener).toBeFocused();
    await expect(first.getByRole('checkbox')).toBeChecked();
    // The stretched title button makes the non-interactive card surface clickable.
    await second.locator('.song-card').click({ position: { x: 12, y: 12 } });
    dialog = page.getByRole('dialog', { name: 'Synthetic Song 2', exact: true });
    await expect(dialog.locator('.lyrics-text')).toHaveText('Synthetic lyrics for Synthetic Song 2\nSynthetic final line');
    await page.keyboard.press('Escape');
    await page.evaluate(async () => (await import('/src/services/lyrics.js')).clearLyricsMemory());
    await page.route('**/songs/lyrics?*', async route => {
        if (new URL(route.request().url()).searchParams.get('title') !== 'Synthetic Song 1') return route.continue();
        await new Promise(resolve => setTimeout(resolve, 300));
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { ...data, lyrics: 'Obsolete lyric fixture' } }) }).catch(() => {});
    });
    const pending = page.waitForRequest(req => new URL(req.url()).pathname === '/songs/lyrics' && new URL(req.url()).searchParams.get('title') === 'Synthetic Song 1');
    await opener.click(); await pending; await page.keyboard.press('Escape');
    await second.getByRole('button', { name: 'Ver letra de Synthetic Song 2, de Test Artist', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Synthetic Song 2', exact: true });
    await expect(dialog.locator('.lyrics-text')).toContainText('Synthetic lyrics for Synthetic Song 2');
    await page.waitForTimeout(400);
    await expect(dialog).not.toContainText('Obsolete lyric fixture');
    await page.keyboard.press('Escape'); await page.unroute('**/songs/lyrics?*');
    await page.evaluate(async () => (await import('/src/services/lyrics.js')).clearLyricsMemory());
    await page.route('**/songs/lyrics?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: {
        ...data, songId: new URL(route.request().url()).searchParams.get('songId'), title: 'Synthetic Song 2', lyrics: 'Synthetic lyrics for Synthetic Song 2\nSynthetic final line', emotions: [], emotionAnalysis: { status: 'unavailable' },
    } }) }));
    await second.getByRole('button', { name: 'Ver letra de Synthetic Song 2, de Test Artist', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Synthetic Song 2', exact: true });
    await expect(dialog.locator('.lyrics-text')).toContainText('Synthetic lyrics for Synthetic Song 2');
    await expect(dialog.getByText('La letra está disponible, pero no se pudieron estimar sus emociones.')).toBeVisible();
    await expect(dialog.getByRole('meter')).toHaveCount(0);
    await page.unroute('**/songs/lyrics?*');
    const beforeRetry = { ...cacheCounters };
    const retryRequest = page.waitForRequest(req => new URL(req.url()).searchParams.get('analysisOnly') === 'true');
    await dialog.getByRole('button', { name: 'Reintentar análisis', exact: true }).click();
    await retryRequest;
    await expect(dialog.locator('.lyrics-text')).toBeVisible();
    await expect(dialog.getByRole('meter')).toHaveCount(3);
    assert.equal(cacheCounters.externalLyricsCalls, beforeRetry.externalLyricsCalls);
    await page.keyboard.press('Escape');
    assert.equal(requests.filter(path => path === '/search-songs').length, searches);
    assert.equal(await page.evaluate(() => localStorage.getItem('me:guest-search-history:v1').includes('Synthetic lyrics for')), false);
    await page.getByRole('button', { name: 'Historial', exact: true }).click();
    await page.getByRole('button', { name: 'Ver Synthetic Source — Test Artist', exact: true }).click();
    const parent = page.getByRole('dialog', { name: 'Synthetic Source — Test Artist', exact: true });
    const nestedOpener = parent.getByRole('button', { name: 'Ver letra de Synthetic Song 1, de Test Artist', exact: true });
    await nestedOpener.click();
    await expect(page.locator('[data-epic-modal]')).toHaveCount(2);
    await expect(page.getByRole('dialog', { name: 'Synthetic Song 1', exact: true }).getByRole('meter')).toHaveCount(3);
    await expect(page.locator('.modal-layer').first()).toHaveAttribute('inert', '');
    await page.keyboard.press('Escape'); await expect(nestedOpener).toBeFocused();
    await expect(parent).toBeVisible(); assert.equal(await page.locator('#root').evaluate(element => element.inert), true);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-epic-modal]')).toHaveCount(0);
    assert.equal(await page.locator('#root').evaluate(element => element.inert), false);
    assert.equal(await page.evaluate(() => document.body.style.overflow), '');
    assert.deepEqual(pageErrors, []);
    await page.context().close();
});

test('Song cache browser acceptance: sessions, refresh, history, playlists, 18 responsive language/theme views', { timeout: 120000 }, async t => {
    const page = await pageFor(390);
    const dir = fileURLToPath(new URL('../../ai/song-cache/evidence/final/', import.meta.url));
    await mkdir(dir, { recursive: true });
    const baseline = { ...cacheCounters };
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click(); await register(page, 'cache_acceptance');
    await page.getByLabel('Fragmento de letra').fill('cache-acceptance own synthetic fragment');
    await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    assert.equal(cacheCounters.externalLyricsCalls, baseline.externalLyricsCalls);
    assert.equal(cacheCounters.emotionAICalls, baseline.emotionAICalls);
    const source = page.locator('.song-card').first();
    await source.getByRole('button', { name: 'Ver letra completa', exact: true }).click();
    await expect(source.locator('.lyrics-text')).toHaveText(fullLyricsFixture);
    await expect(source.getByRole('meter')).toHaveCount(3);
    assert.equal(cacheCounters.externalLyricsCalls - baseline.externalLyricsCalls, 1);
    assert.equal(cacheCounters.emotionAICalls - baseline.emotionAICalls, 1);
    const stored = await Song.findOne({ title: 'Cache Acceptance Source' }).lean();
    assert.equal(stored.lyrics.text, fullLyricsFixture); assert.equal(stored.lyrics.lookupAttempted, true);
    const afterFirst = { ...cacheCounters };
    const httpAfterFirst = requests.filter(path => path === '/songs/lyrics').length;
    for (let i = 0; i < 5; i++) {
        await source.getByRole('button', { name: 'Ocultar letra', exact: true }).click();
        await source.getByRole('button', { name: 'Ver letra completa', exact: true }).click();
        await expect(source.locator('.lyrics-text')).toHaveText(fullLyricsFixture);
    }
    assert.equal(requests.filter(path => path === '/songs/lyrics').length, httpAfterFirst);
    await source.getByRole('button', { name: 'Ocultar letra', exact: true }).click();
    const matrix = [];
    for (const language of ['es', 'en']) for (const [index, theme] of ['dark', 'light', 'custom'].entries()) {
        await page.goto(`${ui}/#/ajustes`);
        await page.getByRole('radio', { name: language === 'es' ? 'Español' : 'English', exact: true }).click();
        await page.locator('.theme-option').nth(index).click();
        await page.goto(`${ui}/#/`);
        await source.getByRole('button', { name: language === 'es' ? 'Ver letra completa' : 'View full lyrics', exact: true }).click();
        for (const width of [320, 390, 1280]) {
            await page.setViewportSize({ width, height: 844 });
            await expect(source.locator('.lyrics-text')).toHaveText(fullLyricsFixture);
            const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
            assert.ok(documentWidth <= width);
            await page.screenshot({ path: `${dir}/song-${language}-${theme}-${width}.png`, fullPage: true, animations: 'disabled' });
            matrix.push({ language, theme, width, documentWidth });
        }
        await source.getByRole('button', { name: language === 'es' ? 'Ocultar letra' : 'Hide lyrics', exact: true }).click();
    }
    assert.equal(requests.filter(path => path === '/songs/lyrics').length, httpAfterFirst);
    await page.goto(`${ui}/#/ajustes`); await page.getByRole('radio', { name: 'Español', exact: true }).click();
    await page.goto(`${ui}/#/`);
    await page.getByRole('checkbox').first().check();
    await page.getByRole('button', { name: 'Guardar selección', exact: true }).click();
    await page.getByRole('textbox', { name: 'Nombre de playlist', exact: true }).fill('Cache Acceptance Playlist');
    await page.getByRole('button', { name: 'Crear con selección', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Mis playlists', exact: true }).click();
    await page.getByRole('button', { name: 'Ver Cache Acceptance Playlist', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Ver letra completa', exact: true }).click();
    await expect(page.getByRole('dialog').locator('.lyrics-text')).toHaveText(fullLyricsFixture);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Historial', exact: true }).click();
    await page.getByRole('button', { name: 'Ver Cache Acceptance Source — Test Artist', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Ver letra completa', exact: true }).click();
    await expect(page.getByRole('dialog').locator('.lyrics-text')).toHaveText(fullLyricsFixture);
    await page.keyboard.press('Escape'); await page.reload();
    await page.getByRole('button', { name: 'Ver Cache Acceptance Source — Test Artist', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Ver letra completa', exact: true }).click();
    await expect(page.getByRole('dialog').locator('.lyrics-text')).toHaveText(fullLyricsFixture);
    const guest = await pageFor(320);
    await guest.getByLabel('Fragmento de letra').fill('cache-acceptance own synthetic fragment');
    const guestSearch = guest.waitForResponse(response => new URL(response.url()).pathname === '/search-songs');
    await guest.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
    const guestResponse = await guestSearch;
    if (guestResponse.status() === 429) {
        // The complete suite shares a real IP limiter. Respect it rather than
        // weakening production limits or interpreting rate limiting as a miss.
        const seconds = Number(guestResponse.headers()['retry-after']);
        assert.ok(Number.isFinite(seconds) && seconds > 0 && seconds <= 60);
        t.diagnostic(`Guest search respected real Retry-After=${seconds}s`);
        await guest.waitForTimeout(seconds * 1000 + 100);
        const retrySearch = guest.waitForResponse(response => new URL(response.url()).pathname === '/search-songs');
        await guest.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
        assert.equal((await retrySearch).status(), 200);
    } else assert.equal(guestResponse.status(), 200);
    await expect(guest.getByRole('checkbox')).toHaveCount(12);
    await guest.getByRole('button', { name: 'Ver letra completa', exact: true }).click();
    await expect(guest.locator('.lyrics-text')).toHaveText(fullLyricsFixture);
    assert.equal(cacheCounters.externalLyricsCalls, afterFirst.externalLyricsCalls);
    assert.equal(cacheCounters.emotionAICalls, afterFirst.emotionAICalls);
    const songDocumentsCount = await Song.countDocuments({ canonicalKey: stored.canonicalKey });
    assert.equal(songDocumentsCount, 1);
    for (const docs of [await Playlist.find({ name: 'Cache Acceptance Playlist' }).lean(), await SearchHistory.find({ 'result.song.songId': stored._id }).lean()]) {
        assert.ok(!JSON.stringify(docs).includes(fullLyricsFixture));
        assert.ok(JSON.stringify(docs).includes(String(stored._id)));
    }
    const localValues = await guest.evaluate(() => Object.values(localStorage).join(' '));
    assert.ok(!localValues.includes('Synthetic complete lyrics fixture'));
    const metrics = { externalLyricsCalls: cacheCounters.externalLyricsCalls - baseline.externalLyricsCalls,
        emotionAICalls: cacheCounters.emotionAICalls - baseline.emotionAICalls, songDocumentsCount, views: matrix.length,
        cacheHitResponses: cacheCounters.cacheHitResponses - (baseline.cacheHitResponses || 0) };
    await writeFile(`${dir}/browser-matrix.json`, JSON.stringify({ metrics, matrix }, null, 2));
    t.diagnostic(JSON.stringify(metrics));
    await guest.context().close(); await page.context().close();
});

test('Song refetch UI: explicit recovery, visible cooldown, ES/EN and rights preserved', { timeout: 45000 }, async t => {
    const directory = fileURLToPath(new URL('../../ai/song-cache/evidence/loop-08/', import.meta.url));
    await mkdir(directory, { recursive: true });
    const baseline = { ...cacheCounters };
    for (const [fixture, language] of [['missing', 'es'], ['restricted', 'en']]) {
        const page = await pageFor(390);
        try {
            if (language === 'en') {
                await page.goto(`${ui}/#/ajustes`); await page.getByRole('radio', { name: 'English', exact: true }).click(); await page.goto(`${ui}/#/`);
            }
            await page.locator('#lyrics').fill(`refetch-${fixture} own synthetic fragment`);
            await page.locator('.discovery-form .btn--primary').click();
            await expect(page.getByRole('checkbox')).toHaveCount(12);
            const source = page.locator('.song-card').first();
            const openName = language === 'es' ? 'Ver letra completa' : 'View full lyrics';
            await source.getByRole('button', { name: openName, exact: true }).click();
            const retry = source.getByRole('button', { name: language === 'es' ? 'Volver a buscar letra y emociones' : 'Fetch lyrics and emotions again', exact: true });
            await expect(retry).toBeVisible(); await expect(retry).toBeDisabled();
            await expect(source.getByRole('status').filter({ hasText: language === 'es' ? /Podrás reintentar/ : /You can retry/ })).toBeVisible();
            const calls = cacheCounters.externalLyricsCalls;
            await expect(retry).toBeEnabled(); assert.equal(cacheCounters.externalLyricsCalls, calls);
            if (fixture === 'restricted') await expect(source).toContainText('retrying does not remove the rights restriction');
            const refreshed = page.waitForResponse(response => new URL(response.url()).searchParams.get('refetchLyrics') === 'true');
            await retry.click();
            const payload = await (await refreshed).json();
            assert.equal(cacheCounters.externalLyricsCalls, calls + 1);
            if (fixture === 'missing') {
                assert.equal(payload.data.status, 'available'); assert.equal(payload.data.emotionAnalysis.status, 'estimated');
                await expect(source.locator('.lyrics-text')).toHaveText(fullLyricsFixture);
                await expect(source.getByRole('meter')).toHaveCount(3);
            } else {
                assert.equal(payload.data.status, 'rights_restricted'); assert.equal(payload.data.lyrics, null);
                await expect(source.locator('.lyrics-text')).toHaveCount(0); await expect(source.getByRole('meter')).toHaveCount(0);
                await expect(retry).toBeDisabled();
            }
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await source.screenshot({ path: `${directory}/refetch-${fixture}-${language}.png`, animations: 'disabled' });
            await source.getByRole('button', { name: language === 'es' ? 'Ocultar letra' : 'Hide lyrics', exact: true }).click();
            await source.getByRole('button', { name: openName, exact: true }).click();
            assert.equal(cacheCounters.externalLyricsCalls, calls + 1);
        } finally { await page.context().close(); }
    }
    assert.equal(cacheCounters.externalLyricsCalls - baseline.externalLyricsCalls, 4);
    assert.equal(cacheCounters.emotionAICalls - baseline.emotionAICalls, 1);
    t.diagnostic(JSON.stringify({ externalLyricsCalls: cacheCounters.externalLyricsCalls - baseline.externalLyricsCalls,
        emotionAICalls: cacheCounters.emotionAICalls - baseline.emotionAICalls }));
});

test('Song transient recovery UI: old restricted LRCLIB record opens with text and emotions without persistent text', { timeout: 45000 }, async t => {
    const input = { title: 'Transient Recovery Fixture', artist: 'Test Artist' };
    // Reproduce the previous release's persisted local block, using own text only.
    const previous = await createSongCache({ transientPolicy: () => false,
        lookup: async song => ({ ...song, status: 'available', lyrics: fullLyricsFixture, source: { name: 'LRCLIB', url: 'https://lrclib.net' } }),
    })(input);
    assert.equal(previous.status, 'rights_restricted');
    const baseline = { ...cacheCounters };
    const page = await pageFor(390);
    try {
        await page.locator('#lyrics').fill('transient-recovery own synthetic fragment');
        await page.locator('.discovery-form .btn--primary').click();
        await expect(page.getByRole('checkbox')).toHaveCount(12);
        const source = page.locator('.song-card').first();
        await source.getByRole('button', { name: 'Ver letra completa', exact: true }).click();
        await expect(source.locator('.lyrics-text')).toHaveText(fullLyricsFixture);
        await expect(source.getByRole('meter')).toHaveCount(3);
        await expect(source).toContainText('Letra consultada bajo demanda');
        await expect(source).not.toContainText('no están autorizados');
        const stored = await Song.findById(previous.songId).lean();
        assert.equal(stored.lyrics.status, 'transient'); assert.equal(stored.lyrics.text, null);
        assert.equal(stored.emotionAnalysis.status, 'estimated');
        assert.ok(!JSON.stringify(stored).includes(fullLyricsFixture));
        await source.getByRole('button', { name: 'Ocultar letra', exact: true }).click();
        await source.getByRole('button', { name: 'Ver letra completa', exact: true }).click();
        await expect(source.locator('.lyrics-text')).toHaveText(fullLyricsFixture);
        const directory = fileURLToPath(new URL('../../ai/song-cache/evidence/loop-09/', import.meta.url));
        await mkdir(directory, { recursive: true });
        await source.screenshot({ path: `${directory}/transient-recovered-390.png`, animations: 'disabled' });
        await page.reload();
        await page.getByRole('button', { name: 'Historial', exact: true }).click();
        await page.getByRole('button', { name: 'Ver Transient Recovery Fixture — Test Artist', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Ver letra completa', exact: true }).click();
        await expect(page.getByRole('dialog').locator('.lyrics-text')).toHaveText(fullLyricsFixture);
        await expect(page.getByRole('dialog').getByRole('meter')).toHaveCount(3);
        assert.equal(cacheCounters.externalLyricsCalls - baseline.externalLyricsCalls, 1);
        assert.equal(cacheCounters.emotionAICalls - baseline.emotionAICalls, 1);
        assert.ok(!await page.evaluate(text => Object.values(localStorage).join(' ').includes(text), fullLyricsFixture));
        t.diagnostic(JSON.stringify({ externalLyricsCalls: cacheCounters.externalLyricsCalls - baseline.externalLyricsCalls,
            emotionAICalls: cacheCounters.emotionAICalls - baseline.emotionAICalls, storedFullText: stored.lyrics.text !== null }));
    } finally { await page.context().close(); }
});
