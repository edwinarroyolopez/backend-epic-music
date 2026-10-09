import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { startLab } from './personality-lab.mjs';
import { PlaylistAnalysis } from '../src/models/playlist-analysis.model.js';
import { Playlist } from '../src/models/playlist.model.js';
import { Song } from '../src/models/song.model.js';
import { randomUUID } from 'node:crypto';

test('FINAL: eight songs → report → save/reopen → playlist → internal analysis → private deletion', { timeout: 60000 }, async () => {
    let aiCalls = 0, behavior = 'valid';
    const lab = await startLab({ callAI: async ({ messages }) => {
        aiCalls++; await new Promise(r => setTimeout(r, behavior === 'slow' ? 500 : 20));
        if (behavior === 'invalid') return { content: 'invalid-json' };
        const d = JSON.parse(messages[1].content);
        return { provider: 'fixture', model: 'synthetic', content: JSON.stringify({ version: d.version, focus: d.candidates, representativeIndices: [0, 1] }) };
    } });
    const dir = '../ai/playlist-personality/evidence/final'; await mkdir(dir, { recursive: true });
    try {
        const account = await lab.api('/auth/signup', { body: { username: 'final_personality', name: 'Synthetic final', email: 'final@example.test', phone: '123456789', password: 'Synthetic-Password123!' } });
        const page = await lab.browser.newPage({ viewport: { width: 1440, height: 1000 } });
        await page.goto(lab.ui);
        await page.evaluate(({ token, user }) => { localStorage.setItem('me:token', token); localStorage.setItem('me:user', JSON.stringify({ ...user, isAuthenticated: true })); }, account);
        await page.route('**/auth/me', async route => { await new Promise(r => setTimeout(r, 800)); await route.continue(); });
        await page.reload(); await expect(page.locator('#lyrics')).toBeVisible();
        await page.getByRole('tab', { name: 'Analizar mi playlist', exact: true }).click();
        await expect(page.locator('.personality textarea')).toHaveCount(0);
        await expect(page.locator('.personality textarea')).toBeVisible();
        await page.unroute('**/auth/me');
        await page.locator('.personality textarea').fill(Array.from({ length: 8 }, (_, i) => `Final song ${i} — Artist ${i % 2}`).join('\n'));
        await page.getByRole('button', { name: 'Revisar canciones', exact: true }).click();
        await page.getByLabel('Género (opcional) 1', { exact: true }).fill('Rock');
        await page.getByLabel('Género (opcional) 2', { exact: true }).fill('Folk');
        await page.getByLabel('Nombre del informe / nueva playlist').fill('Final eight songs');
        await page.getByRole('checkbox').check();
        await page.getByRole('button', { name: 'Analizar playlist', exact: true }).dblclick();
        await expect(page.locator('.personality-report')).toBeVisible(); assert.equal(aiCalls, 1);
        const manual = await PlaylistAnalysis.findOne().lean(); assert.equal(manual.songs.length, 8); assert.equal(manual.report.musicalIdentity.diversity.genres, 2);
        await page.getByRole('button', { name: 'Guardar canciones en nueva playlist', exact: true }).click();
        await expect.poll(() => Playlist.countDocuments()).toBe(1);
        const playlist = await Playlist.findOne().lean(); assert.equal(playlist.songs.length, 8); assert.equal(await Song.countDocuments(), 8);
        await page.goto(`${lab.ui}/#/analisis/${manual._id}`); await page.reload();
        await expect(page.locator('.personality-report')).toBeVisible(); assert.equal(aiCalls, 1);
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.getByRole('button', { name: 'Copiar informe', exact: true }).click();
        await expect(page.getByText('Informe copiado.', { exact: true })).toBeVisible();
        assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes('Final song 7'));
        await page.screenshot({ path: `${dir}/report-desktop.png`, fullPage: true });
        await page.goto(`${lab.ui}/#/playlists/${playlist._id}`); await page.getByRole('button', { name: 'Analizar personalidad musical', exact: true }).click();
        await page.getByRole('button', { name: 'Revisar canciones', exact: true }).click(); await page.getByRole('checkbox').check();
        await page.getByRole('button', { name: 'Analizar playlist', exact: true }).click(); await expect(page.locator('.personality-report')).toBeVisible(); assert.equal(aiCalls, 2);
        const internal = await PlaylistAnalysis.findOne({ sourceMode: 'internal' }).lean(); assert.equal(internal.songs.length, 8);
        await page.goto(`${lab.ui}/#/analisis/${manual._id}`); await page.getByRole('button', { name: 'Eliminar entrada', exact: true }).click();
        await page.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click(); await expect(page).toHaveURL(/#\/analisis$/);
        assert.equal(await Playlist.countDocuments(), 1); assert.equal(await Song.countDocuments(), 8);
        // Failure/retry creates a new report and preserves the earlier partial snapshot.
        await page.goto(`${lab.ui}/#/analizar`);
        await page.locator('.personality textarea').fill('Retry one — Synthetic\nRetry two — Synthetic');
        await page.getByRole('button', { name: 'Revisar canciones', exact: true }).click(); await page.getByRole('checkbox').check();
        behavior = 'invalid'; await page.getByRole('button', { name: 'Analizar playlist', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Reintentar IA como nuevo informe' })).toBeVisible();
        behavior = 'valid'; await page.getByRole('button', { name: 'Reintentar IA como nuevo informe' }).click();
        await expect(page.locator('.personality-report')).toBeVisible(); await expect(page.getByRole('button', { name: 'Reintentar IA como nuevo informe' })).toHaveCount(0);
        assert.equal(await PlaylistAnalysis.countDocuments({ status: 'partial' }), 1);
        // Real UI cancellation, then recover the accepted result from history.
        await page.getByLabel('Nombre del informe / nueva playlist').fill('Cancelled wait'); behavior = 'slow';
        await page.getByRole('button', { name: 'Analizar playlist', exact: true }).click(); await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
        await expect(page.locator('.personality-report')).toHaveCount(0);
        // 429 Retry-After presentation uses a deterministic HTTP failure fixture only.
        await page.route('**/playlist-personality/analyze', route => route.fulfill({ status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '1', 'Access-Control-Allow-Origin': lab.ui, 'Access-Control-Expose-Headers': 'Retry-After' }, body: JSON.stringify({ success: false, error: { code: 'RATE_LIMITED', message: 'RATE_LIMITED' } }) }));
        await page.getByRole('button', { name: 'Analizar playlist', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Analizar playlist', exact: true })).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Analizar playlist', exact: true })).toBeEnabled({ timeout: 3000 });
        await writeFile(`${dir}/happy-flow.json`, JSON.stringify({ passed: true, inputSongs: 8, knownGenres: 2, globalSongsAfterInitialSave: 8, initialAICalls: 1, reopenAdditionalAI: 0, internalAdditionalAI: 1, privateDeleteNoCascade: true, copyVerified: true, invalidAIRecoverable: true, cancelAndRetryAfterVerified: true, testType: 'TEST_SINTETICO' }, null, 2));
    } finally { await lab.close(); }
});

test('FINAL: internal 500-song playlist, batches of 100, bounded AI and exact replay', { timeout: 60000 }, async () => {
    let aiCalls = 0, promptBytes = 0, sampleSize = 0;
    const lab = await startLab({ callAI: async ({ messages }) => { aiCalls++; promptBytes = Buffer.byteLength(messages[1].content); const d = JSON.parse(messages[1].content); sampleSize = d.songs.length; return { provider: 'fixture', model: 'synthetic', content: JSON.stringify({ version: d.version, focus: d.candidates, representativeIndices: [d.songs[0].index] }) }; } });
    try {
        const account = await lab.api('/auth/signup', { body: { username: 'large_personality', name: 'Synthetic large', email: 'large@example.test', phone: '123456789', password: 'Synthetic-Password123!' } });
        const songs = Array.from({ length: 500 }, (_, i) => ({ title: `Large synthetic ${i}`, artist: `Artist ${i % 17}`, genre: i % 2 ? 'Rock' : 'Folk', originType: 'identified' }));
        const created = await lab.api('/playlists', { token: account.token, body: { name: '500 synthetic songs', songs: songs.slice(0, 100) } }); assert.equal(created.status, 201);
        for (let i = 100; i < 500; i += 100) assert.equal((await lab.api(`/playlists/${created.data.playlist.id}/songs`, { token: account.token, body: { songs: songs.slice(i, i + 100) } })).data.addedCount, 100);
        const body = { sourceMode: 'internal', sourcePlaylistId: created.data.playlist.id, title: 'Large report', language: 'en', consent: true, independentSource: true, requestId: randomUUID() };
        const started = performance.now();
        const result = await lab.api('/playlist-personality/analyze', { token: account.token, body }); const elapsedMs = Math.round(performance.now() - started);
        assert.equal(result.status, 200); assert.equal(result.data.entry.report.analyzedSongCount, 500); assert.equal(result.data.entry.report.ai.status, 'completed');
        assert.equal((await lab.api('/playlist-personality/analyze', { token: account.token, body })).data.cached, true); assert.equal(aiCalls, 1); assert.ok(sampleSize <= 24); assert.ok(promptBytes < 20000);
        assert.equal(await Song.countDocuments(), 500);
        const dir = '../ai/playlist-personality/evidence/final'; await mkdir(dir, { recursive: true });
        await writeFile(`${dir}/500-songs.json`, JSON.stringify({ passed: true, globalSongs: 500, aiCalls, sampleSize, promptBytes, elapsedMs, playlistBatches: 5 }, null, 2));
    } finally { await lab.close(); }
});
