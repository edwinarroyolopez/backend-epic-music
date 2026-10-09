import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer } from '../../frontend-epic-music/node_modules/vite/dist/node/index.js';

test('personality Home: keyboard, editable preview, original input, mobile', async () => {
    const phase = process.env.PERSONALITY_PHASE || 'loop-01';
    const dir = fileURLToPath(new URL(`../../ai/playlist-personality/evidence/${phase}/`, import.meta.url));
    await mkdir(dir, { recursive: true });
    const vite = await createServer({ root: fileURLToPath(new URL('../../frontend-epic-music', import.meta.url)), server: { host: '127.0.0.1', port: 5173, strictPort: true }, logLevel: 'error' });
    let browser;
    try {
        await vite.listen(); browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 320, height: 900 }, hasTouch: true });
        const requests = [], errors = [];
        await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
        page.on('request', r => { if (r.method() === 'POST') requests.push(new URL(r.url()).pathname); });
        page.on('pageerror', e => errors.push(e.message));
        await page.goto('http://127.0.0.1:5173');
        await page.locator('#lyrics').fill('Synthetic original search input');
        await page.screenshot({ path: `${dir}/home-320.png`, fullPage: true });
        if (phase !== 'baseline') {
            const songTab = page.getByRole('tab', { name: 'Encontrar canción', exact: true });
            await songTab.focus(); await page.keyboard.press('ArrowRight');
            await expect(page.getByRole('tab', { name: 'Analizar mi playlist', exact: true })).toBeFocused();
            await page.getByLabel('Canciones independientes', { exact: true }).fill('First — Artist\nSecond — Other\nFirst — Artist\nIncomplete');
            await page.getByRole('button', { name: 'Revisar canciones', exact: true }).click();
            await expect(page.getByLabel('Título 4', { exact: true })).toHaveValue('Incomplete');
            await page.getByLabel('Artista 4', { exact: true }).fill('Corrected');
            await page.screenshot({ path: `${dir}/manual-320.png`, fullPage: true });
            await songTab.tap(); await expect(page.locator('#lyrics')).toHaveValue('Synthetic original search input');
            assert.equal(requests.filter(p => p === '/search-songs').length, 0);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.deepEqual(errors, []);
        await writeFile(`${dir}/ui.json`, JSON.stringify({ phase, requests, pageErrors: errors, overflow: false, testType: 'TEST_SINTETICO', passed: true }, null, 2));
    } finally { await browser?.close(); await vite.close(); }
});
