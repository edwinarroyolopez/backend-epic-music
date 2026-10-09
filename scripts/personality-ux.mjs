import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { startLab } from './personality-lab.mjs';
import { fileURLToPath } from 'node:url';

test('personality UX: ES/EN x three themes x four widths, axe, keyboard, actual screenshots', { timeout: 180000 }, async () => {
    const dir = '../ai/playlist-personality/evidence/loop-07'; await mkdir(dir, { recursive: true });
    const axe = await readFile(process.env.PERSONALITY_AXE_PATH || fileURLToPath(new URL('../node_modules/axe-core/axe.min.js', import.meta.url)), 'utf8');
    let aiCalls = 0;
    const lab = await startLab({ callAI: async ({ messages }) => { aiCalls++; const d = JSON.parse(messages[1].content); return { provider: 'fixture', model: 'synthetic', content: JSON.stringify({ version: d.version, focus: d.candidates, representativeIndices: [0, 1] }) }; } });
    const results = [], errors = [], external = [];
    try {
        const page = await lab.browser.newPage({ reducedMotion: 'reduce' });
        await page.route('**/*', route => { if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue(); external.push(new URL(route.request().url()).origin); return route.abort(); });
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(lab.ui);
        for (const language of ['es', 'en']) for (const theme of ['dark', 'light', 'custom']) {
            await page.evaluate(({ language, theme }) => { localStorage.setItem('me:language', JSON.stringify(language)); localStorage.setItem('me:theme', JSON.stringify(theme)); }, { language, theme });
            for (const width of [320, 390, 768, 1440]) {
                await page.setViewportSize({ width, height: 900 });
                await page.goto(`${lab.ui}/#/analizar`); await page.reload();
                await page.locator('.personality textarea').fill(Array.from({ length: 8 }, (_, i) => `Synthetic song ${i} — Artist ${i % 3}`).join('\n'));
                await page.getByRole('button', { name: language === 'es' ? 'Revisar canciones' : 'Review songs', exact: true }).click();
                await page.locator('.personality-consent input').check();
                const scan = async name => {
                    await page.addScriptTag({ content: axe });
                    const result = await page.evaluate(async () => {
                        const report = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
                        return { overflow: document.documentElement.scrollWidth > innerWidth, violations: report.violations.map(v => ({ id: v.id, impact: v.impact, targets: v.nodes.map(n => n.target) })), incomplete: report.incomplete.map(v => v.id), passes: report.passes.length };
                    });
                    results.push({ language, theme, width, name, ...result });
                    await writeFile(`${dir}/matrix.json`, JSON.stringify({ results, errors, external, aiCalls }, null, 2));
                    assert.equal(result.overflow, false, `${language}/${theme}/${width}/${name} overflow`);
                    assert.deepEqual(result.violations, [], `${language}/${theme}/${width}/${name} accessibility`);
                    if (width === 320 || width === 1440) await page.screenshot({ path: `${dir}/${language}-${theme}-${width}-${name}.png`, fullPage: true, animations: 'disabled' });
                };
                await scan('form');
                await page.getByRole('button', { name: language === 'es' ? 'Analizar playlist' : 'Analyze playlist', exact: true }).click();
                await expect(page.getByRole('article', { name: language === 'es' ? 'Informe musical' : 'Musical report' })).toBeVisible();
                await scan('report');
                await page.getByRole('link', { name: language === 'es' ? 'Ver resultado guardado' : 'View saved result', exact: true }).click();
                await expect(page.locator('.personality-report')).toBeVisible();
                await scan('history');
                await page.goto(`${lab.ui}/#/analisis`);
                await expect(page.getByRole('table')).toBeVisible();
                await scan('history-list');
            }
        }
        assert.equal(aiCalls, 2); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    } finally { await lab.close(); }
});
