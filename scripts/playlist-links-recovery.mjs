import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { startLab } from './personality-lab.mjs';
import { Song } from '../src/models/song.model.js';
import { Playlist } from '../src/models/playlist.model.js';
import { PlaylistAnalysis } from '../src/models/playlist-analysis.model.js';

const dir = '../ai/playlist-links-recovery/evidence';
const radio = 'https://www.youtube.com/watch?v=abcdefghijk&list=RDabcdefghijk&start_radio=1';
const url = 'https://youtube.com/playlist?list=PLsynthetic12345';
const linkInput = page => page.getByRole('textbox', { name: 'Enlace de Spotify o YouTube', exact: true });
const check = page => page.getByRole('button', { name: 'Comprobar enlace', exact: true }).click();

test('recovery: no configuration is not a policy failure; radio keeps original URL and manual draft', async () => {
    let calls = 0;
    const lab = await startLab({ youtube: { enabled: false, apiKey: '', fetchImpl: () => { calls++; throw new Error(); } }, callAI: () => { calls++; throw new Error(); } });
    const results = [], network = [];
    try {
        const page = await lab.browser.newPage({ reducedMotion: 'reduce' });
        await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
        page.on('response', r => { if (r.url().startsWith(lab.base)) network.push({ path: new URL(r.url()).pathname, status: r.status() }); });
        await page.goto(lab.ui);
        await page.locator('#lyrics').fill('Synthetic independent search draft');
        await page.getByRole('tab', { name: 'Analizar mi playlist', exact: true }).click();
        await page.getByLabel('Canciones independientes', { exact: true }).fill('Independent One — Author A\nIndependent Two — Author B');
        await page.getByRole('button', { name: 'Revisar canciones', exact: true }).click();
        await page.getByLabel('Cómo aportar canciones').selectOption('link');
        for (const [name, input, status, message] of [
            ['radio', radio, 'dynamic_radio', /Radio o mezcla automática/],
            ['youtube', url, 'configuration_required', /Lectura sin configurar/],
            ['spotify', 'https://open.spotify.com/intl-es/playlist/0000000000000000000000?si=synthetic', 'configuration_required', /Integración de lectura pendiente/],
        ]) {
            await linkInput(page).fill(input);
            const wait = page.waitForResponse(r => r.url().endsWith('/playlist-personality/preview'));
            await check(page); const response = await wait, body = await response.json();
            assert.equal(body.data.status, status); assert.equal(body.data.preview, undefined);
            await expect(page.getByText(message)).toBeVisible();
            if (name === 'radio') {
                await expect(page.getByRole('link', { name: 'Abrir radio en YouTube' })).toHaveAttribute('href', radio);
                await page.getByRole('button', { name: 'Usar una playlist fija' }).click(); await expect(linkInput(page)).toBeFocused();
            }
            results.push({ name, http: response.status(), data: body.data });
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: `${dir}/recognized-${name}.png`, fullPage: true });
        }
        await page.getByRole('button', { name: 'Escribir canciones independientes', exact: true }).click();
        await expect(page.getByLabel('Título 1', { exact: true })).toHaveValue('Independent One');
        await page.getByLabel('Cómo aportar canciones').selectOption('link');
        await expect(linkInput(page)).toHaveValue(results[2].data.originalUrl);
        await page.getByRole('tab', { name: 'Encontrar canción', exact: true }).click();
        await expect(page.locator('#lyrics')).toHaveValue('Synthetic independent search draft');
        assert.equal(calls, 0);
        await writeFile(`${dir}/classification.json`, JSON.stringify({ fixtureOnly: true, results, network, externalMetadataCalls: 0, aiCalls: 0, draftsPreserved: true }, null, 2));
    } finally { await lab.close(); }
});

test('recovery: real HTTP/browser with synthetic YouTube and AI transports, files, isolation, axe and pagination', { timeout: 180000 }, async () => {
    let aiCalls = 0;
    const apiRequests = [], network = [], errors = [], matrix = [], blockedExternal = [];
    const fixtureItem = i => ({ snippet: { title: `API fixture video ${i}`, videoOwnerChannelTitle: 'API fixture channel' }, contentDetails: { videoId: 'abcdefghijk' } });
    const lab = await startLab({
        youtube: { enabled: true, apiKey: 'fixture-only', fetchImpl: async (target, options) => {
            assert.equal(target.origin, 'https://www.googleapis.com'); assert.equal(options.redirect, 'error');
            apiRequests.push({ path: target.pathname, page: target.searchParams.has('pageToken') ? 2 : 1 });
            return new Response(JSON.stringify(target.pathname.endsWith('/playlists') ? { items: [{ snippet: { title: 'Synthetic API playlist' } }] } : {
                items: target.searchParams.has('pageToken') ? [fixtureItem(3)] : [fixtureItem(1), fixtureItem(2)], pageInfo: { totalResults: 3 }, ...(!target.searchParams.has('pageToken') && { nextPageToken: 'synthetic-next' }),
            }));
        } },
        callAI: async ({ messages }) => { aiCalls++; const d = JSON.parse(messages[1].content); return { provider: 'fixture', model: 'synthetic', content: JSON.stringify({ version: d.version, focus: d.candidates, representativeIndices: [0, 1] }) }; },
    });
    try {
        const page = await lab.browser.newPage({ reducedMotion: 'reduce' });
        await page.route('**/*', r => { if (new URL(r.request().url()).hostname === '127.0.0.1') return r.continue(); blockedExternal.push(new URL(r.request().url()).origin); return r.abort(); });
        page.on('pageerror', e => errors.push(e.message));
        page.on('response', r => { if (r.url().startsWith(lab.base)) network.push({ path: new URL(r.url()).pathname, status: r.status() }); });
        await page.goto(`${lab.ui}/#/analizar`); await page.getByLabel('Cómo aportar canciones').selectOption('link');
        await linkInput(page).fill(url); await check(page);
        await expect(page.getByRole('heading', { name: 'Synthetic API playlist' })).toBeVisible();
        await expect(page.locator('.personality-provider-items li')).toHaveCount(2);
        await page.getByRole('button', { name: 'Cargar más vídeos' }).click();
        await expect(page.locator('.personality-provider-items li')).toHaveCount(3);
        assert.equal(apiRequests.length, 3); assert.equal(aiCalls, 0);
        assert.equal(await Song.countDocuments(), 0); assert.equal(await PlaylistAnalysis.countDocuments(), 0);
        await page.screenshot({ path: `${dir}/preview-paginated.png`, fullPage: true });

        const baseInput = { sourceMode: 'manual', sourceProvenance: 'user_independent', consent: true, independentSource: true, language: 'es', requestId: randomUUID(), songs: [{ title: 'Own fixture first', artist: 'Own author' }, { title: 'Own fixture second', artist: 'Own author' }] };
        const negative = [];
        for (const attack of [
            { sourceMode: 'link', url }, { sourceProvenance: 'provider_api_metadata' }, { provider: 'spotify' },
            { songs: [{ title: 'API fixture video 1', artist: 'API fixture channel', provenance: 'user_independent' }] },
            { songs: [{ title: 'API fixture video 2', artist: 'API fixture channel' }] },
            { songs: [{ title: 'Forged', artist: 'IDs', songId: '000000000000000000000000' }] },
        ]) {
            const result = await lab.api('/playlist-personality/analyze', { body: { ...baseInput, ...attack } });
            assert.equal(result.status, 422); assert.equal(result.error.code, 'SOURCE_PROVENANCE_RESTRICTED'); negative.push({ status: result.status, code: result.error.code });
        }
        assert.equal(aiCalls, 0); assert.equal(await Song.countDocuments(), 0); assert.equal(await PlaylistAnalysis.countDocuments(), 0);
        const account = async suffix => lab.api('/auth/signup', { body: { username: `recovery_${suffix}`, name: 'Synthetic', email: `recovery_${suffix}@example.test`, phone: `1234567${suffix}`, password: 'Synthetic-Password123!' } });
        const a = await account('a'), b = await account('b');
        assert.ok(a.token && b.token, 'both synthetic accounts must exist before ownership checks');
        const created = await lab.api('/playlists', { token: a.token, body: { name: 'Own fixture', songs: baseInput.songs.map(s => ({ ...s, originType: 'identified' })) } });
        const id = created.data.playlist.id;
        assert.equal((await lab.api('/playlist-personality/preview', { token: b.token, body: { sourceMode: 'internal', sourcePlaylistId: id } })).status, 404);
        assert.equal((await lab.api('/playlist-personality/preview', { body: { sourceMode: 'internal', sourcePlaylistId: id } })).status, 401);
        assert.equal((await lab.api('/playlist-personality/preview', { token: a.token, body: { sourceMode: 'internal', sourcePlaylistId: id } })).data.totalSongCount, 2);
        await Playlist.collection.updateOne({ _id: (await Playlist.findOne())._id }, { $set: { 'songs.0.sourceProvenance': 'provider_api_metadata' } });
        const beforeSongs = await Song.countDocuments();
        const tampered = await lab.api('/playlist-personality/analyze', { token: a.token, body: { ...baseInput, sourceMode: 'internal', sourceProvenance: 'internal_selection', sourcePlaylistId: id } });
        assert.equal(tampered.status, 422); assert.equal(aiCalls, 0); assert.equal(await Song.countDocuments(), beforeSongs);

        await page.getByRole('button', { name: 'Escribir canciones independientes', exact: true }).click();
        const fileInput = page.getByLabel('Subir archivo independiente CSV, TXT o JSON');
        await fileInput.setInputFiles({ name: 'synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from('title,artist,genre,edition\nIndependent one,Author one,Rock,\nIndependent two,Author two,Folk,\nIndependent one,Author one,Rock,') });
        await expect(page.getByLabel('Título 1', { exact: true })).toHaveValue('Independent one');
        await expect(page.getByText('Repetida', { exact: false }).first()).toBeVisible();
        await page.getByLabel('Cómo aportar canciones').selectOption('link');
        await expect(page.locator('.personality-provider-items li')).toHaveCount(3);
        await page.getByLabel('Cómo aportar canciones').selectOption('manual');
        await expect(page.getByLabel('Título 1', { exact: true })).toHaveValue('Independent one');
        await page.getByRole('checkbox').check();
        await page.getByRole('button', { name: 'Analizar playlist', exact: true }).click();
        await expect(page.getByRole('article', { name: 'Informe musical' })).toBeVisible(); assert.equal(aiCalls, 1);
        await page.screenshot({ path: `${dir}/file-report.png`, fullPage: true });
        await page.getByRole('link', { name: 'Ver resultado guardado', exact: true }).click(); await page.reload();
        await expect(page.getByRole('article', { name: 'Informe musical' })).toBeVisible(); assert.equal(aiCalls, 1);
        await page.screenshot({ path: `${dir}/file-history.png`, fullPage: true });
        const axe = await readFile(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
        for (const language of ['es', 'en']) for (const theme of ['light', 'dark', 'custom']) for (const width of [320, 390, 768, 1440]) {
            await page.evaluate(({ language, theme }) => { localStorage.setItem('me:language', JSON.stringify(language)); localStorage.setItem('me:theme', JSON.stringify(theme)); }, { language, theme });
            await page.setViewportSize({ width, height: 900 }); await page.goto(`${lab.ui}/#/analizar`); await page.reload();
            await page.locator('.personality select').first().selectOption('link');
            await page.locator('.personality input[type=url]').fill(url);
            const button = page.getByRole('button', { name: language === 'es' ? 'Comprobar enlace' : 'Check link', exact: true });
            await button.focus(); await page.keyboard.press('Enter');
            await expect(page.locator('.personality-provider-items li')).toHaveCount(2);
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
            await page.evaluate(async () => {
                await document.fonts.ready;
                await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
            });
            await page.addScriptTag({ content: axe });
            const scan = await page.evaluate(async () => ({ overflow: document.documentElement.scrollWidth > innerWidth, violations: (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } })).violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })) }));
            matrix.push({ language, theme, width, ...scan });
            assert.equal(scan.overflow, false); assert.deepEqual(scan.violations, []);
            if (theme === 'light') await page.screenshot({ path: `${dir}/preview-${language}-${width}.png`, fullPage: true });
        }
        assert.deepEqual(errors, []); assert.deepEqual(blockedExternal, []);
        await writeFile(`${dir}/browser.json`, JSON.stringify({ status: 'PASS', testType: 'local Express/Mongo/Chromium; injected synthetic provider and AI transports; NO remote access', apiRequests, network, aiCalls, historyAdditionalAI: 0, negative, crossUser: 'PASS', storedProvenanceTampering: 'rejected', matrix, errors, blockedExternal }, null, 2));
    } catch (error) {
        await writeFile(`${dir}/browser-failure.json`, JSON.stringify({ status: 'FAIL', error: error.message, apiRequests, network, matrix, errors }, null, 2)); throw error;
    } finally { await lab.close(); }
});
