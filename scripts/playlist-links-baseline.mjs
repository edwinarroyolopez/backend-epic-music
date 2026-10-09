import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { startLab } from './personality-lab.mjs';
import { expect } from '@playwright/test';

const dir = '../ai/playlist-links-recovery/evidence';
let aiCalls = 0;
const lab = await startLab({ callAI: async () => { aiCalls++; throw new Error('Baseline must not analyze'); } });
try {
    const page = await lab.browser.newPage();
    const network = [], cases = [];
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    page.on('response', r => { if (r.url().startsWith(lab.base)) network.push({ path: new URL(r.url()).pathname, status: r.status() }); });
    await page.goto(`${lab.ui}/#/analizar`);
    await page.getByLabel('Cómo aportar canciones').selectOption('link');
    for (const [name, url] of [
        ['radio', 'https://www.youtube.com/watch?v=abcdefghijk&list=RDabcdefghijk&start_radio=1'],
        ['youtube', 'https://youtube.com/playlist?list=PLsynthetic12345'],
        ['spotify', 'https://open.spotify.com/playlist/0000000000000000000000'],
    ]) {
        await page.getByRole('textbox', { name: 'Enlace de Spotify o YouTube', exact: true }).fill(url);
        const response = page.waitForResponse(r => r.url().endsWith('/playlist-personality/preview'));
        await page.getByRole('button', { name: 'Comprobar enlace', exact: true }).click();
        const result = await response;
        await expect(page.getByText(`${name === 'spotify' ? 'Spotify' : 'YouTube'} · BLOCKED_POLICY`, { exact: true })).toBeVisible();
        cases.push({ name, status: result.status(), response: await result.json() });
        await page.screenshot({ path: `${dir}/baseline-${name}.png`, fullPage: true });
    }
    const manual = await lab.api('/playlist-personality/preview', { body: { sourceMode: 'manual', songs: [{ title: 'Synthetic One', artist: 'Synthetic A' }, { title: 'Synthetic Two', artist: 'Synthetic B' }] } });
    assert.equal(manual.data.totalSongCount, 2);
    assert.equal(aiCalls, 0);
    await writeFile(`${dir}/baseline.json`, JSON.stringify({ fixtureOnly: true, cases, manual, network, aiCalls }, null, 2));
    console.log('Baseline reproduced: 3 BLOCKED_POLICY responses, 2 manual songs, 0 AI calls');
} finally { await lab.close(); }
