import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer } from '../../frontend-epic-music/node_modules/vite/dist/node/index.js';
import { es } from '../../frontend-epic-music/src/translations/es.js';
import { en } from '../../frontend-epic-music/src/translations/en.js';

let vite, browser, axe;
const ui = 'http://127.0.0.1:5173', api = 'http://127.0.0.1:7001';
const user = { id: 'a'.repeat(24), name: 'Landing Fixture', username: 'fixture', email: 'fixture@example.test', active: true };
before(async () => {
    process.env.VITE_API_URL = api;
    vite = await createServer({ root: fileURLToPath(new URL('../../frontend-epic-music', import.meta.url)), server: { host: '127.0.0.1', port: 5173, strictPort: true }, logLevel: 'error' });
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    axe = await readFile(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
});
after(async () => { await browser?.close(); await vite?.close(); });

async function fixturePage({ stored = {}, session, motion = 'no-preference' } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: motion });
    await context.addInitScript(stored => {
        if (!sessionStorage.getItem('fixture-seeded')) {
            for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value);
            sessionStorage.setItem('fixture-seeded', 'true');
        }
    }, stored);
    const page = await context.newPage(), calls = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`${api}/**`, async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        const headers = { 'access-control-allow-origin': ui, 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS' };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        calls.push({ path, headers: request.headers(), body: request.postDataJSON() });
        let status = 200, payload;
        if (path === '/auth/providers') payload = { email: true };
        else if (path === '/auth/login' || path === '/auth/signup') payload = { token: 'fixture-token', user };
        else if (path === '/auth/me') {
            const valid = session ? await session() : true;
            status = valid ? 200 : 401; payload = valid ? { user } : { success: false, message: 'Expired' };
        } else if (path === '/playlists') payload = { success: true, data: { playlists: [] } };
        else if (path === '/search-history') payload = { success: true, data: { entries: [], nextCursor: null } };
        else if (path.startsWith('/search-history/')) payload = { success: true, data: { entry: { id: path.split('/').at(-1), status: 'not_found', createdAt: new Date().toISOString(), result: { found: false }, input: {} } } };
        else if (path === '/search-songs') payload = { success: true, data: { found: false, recommendations: [] } };
        else if (path === '/artists/suggest') payload = { success: true, data: { artists: [] } };
        else { status = 404; payload = { success: false }; }
        await route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    return { context, page, calls, errors };
}

test('public landing has an interactive preview, keyboard controls, motion pause and accessible responsive themes', { timeout: 120000 }, async () => {
    const { context, page, calls, errors } = await fixturePage();
    try {
        await page.goto(ui);
        await expect(page.locator('.landing')).toBeVisible();
        await expect(page.locator('.discovery-form')).toHaveCount(0);
        await expect(page.locator('.header').getByRole('button', { name: 'Buscar', exact: true })).toHaveCount(0);
        await expect(page.locator('.header').getByRole('button', { name: 'Historial', exact: true })).toHaveCount(0);
        await expect(page.locator('.header').getByRole('button', { name: 'Mis playlists', exact: true })).toHaveCount(0);
        const group = page.getByRole('group', { name: es.landing.previewControls });
        await group.getByRole('button', { name: /Descubre/ }).focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('.landing-preview')).toContainText(es.landing.sampleRelated);
        await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
        await expect(page.locator('.landing-preview')).toContainText(es.landing.sampleCollection);
        await page.getByRole('button', { name: es.landing.pauseMotion }).click();
        assert.equal(await page.locator('.landing-vinyl').evaluate(element => getComputedStyle(element).animationPlayState), 'paused');
        await page.getByRole('button', { name: es.landing.resumeMotion }).click();
        assert.equal(await page.locator('.landing-vinyl').evaluate(element => getComputedStyle(element).animationPlayState), 'running');
        await page.getByRole('button', { name: es.landing.explore }).click();
        await expect(page.locator('#landing-experience')).toBeFocused();
        await page.getByRole('button', { name: /Encuentra lo que te ronda/ }).click();
        await expect(page.locator('#landing-feature-remember')).toBeVisible();
        await expect(page.locator('#landing-feature-keep')).toBeHidden();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal(await page.locator('.landing-vinyl').evaluate(element => getComputedStyle(element).animationName), 'none');
        assert.deepEqual(calls, [], 'Public preview must not request API data');
        for (const language of ['es', 'en']) for (const theme of ['dark', 'light', 'custom']) for (const width of [320, 768, 1440]) {
            await page.evaluate(({ language, theme }) => { localStorage.setItem('me:language', JSON.stringify(language)); localStorage.setItem('me:theme', JSON.stringify(theme)); }, { language, theme });
            await page.setViewportSize({ width, height: 1000 });
            await page.reload();
            await expect(page.locator('.landing')).toBeVisible();
            const overflow = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
                elements: [...document.querySelectorAll('body *')].filter(element => { const rect = element.getBoundingClientRect(); return rect.width && (rect.right > innerWidth + 1 || rect.left < -1); }).map(element => element.className).filter(value => typeof value === 'string') }));
            if (process.env.UX_SCREENSHOTS && language === 'es' && theme !== 'custom' && width !== 768) await page.screenshot({ path: `${process.env.UX_SCREENSHOTS}/landing-${theme}-${width}.png`, fullPage: true });
            assert.equal(overflow.overflow, false, `${language}/${theme}/${width} overflow: ${JSON.stringify(overflow.elements)}`);
            await page.addScriptTag({ content: axe });
            const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(value => ({ id: value.id, nodes: value.nodes.map(node => node.target) })));
            assert.deepEqual(violations, [], `${language}/${theme}/${width} accessibility`);
        }
        assert.deepEqual(Object.keys(es.landing).sort(), Object.keys(en.landing).sort());
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('guest and legacy demo sessions cannot mount search, history or playlists; registration CTA works', async () => {
    const { context, page, calls, errors } = await fixturePage({ stored: {
        'me:user': JSON.stringify({ provider: 'demo', isAuthenticated: true, displayName: 'Old demo' }),
        'me:guest-search-history:v1': JSON.stringify([{ song: { title: 'PRIVATE MARKER' } }]),
    } });
    try {
        await page.goto(ui);
        await expect(page.locator('.landing')).toBeVisible();
        await page.getByRole('link', { name: es.landing.start, exact: true }).click();
        await expect(page).toHaveURL(/#\/registro$/);
        await expect(page.locator('#auth-name')).toBeVisible();
        await expect(page.getByRole('button', { name: /demostración|demo/i })).toHaveCount(0);
        for (const path of ['/historial', '/historial/abc', '/playlists', '/playlists/abc', '/analisis', '/analisis/abc', '/perfil', '/cuenta']) {
            await page.goto(`${ui}/#${path}`);
            await expect(page).toHaveURL(/#\/login$/);
            await expect(page.locator('.login')).toBeVisible();
            await expect(page.locator('.history-page, .playlist-page, .discovery-form, .personality')).toHaveCount(0);
            await expect(page.getByText('PRIVATE MARKER')).toHaveCount(0);
        }
        assert.ok(calls.every(call => call.path === '/auth/providers'), JSON.stringify(calls));
        await page.goto(`${ui}/#/ajustes`);
        await expect(page.getByRole('heading', { name: 'Ajustes', exact: true })).toBeVisible();
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('restoring/expired sessions never flash private UI, and real login restores destination and clears on logout', { timeout: 30000 }, async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const restoring = await fixturePage({ stored: { 'me:token': 'expired', 'me:user': JSON.stringify({ ...user, provider: 'email' }) }, session: () => gate });
    try {
        await restoring.page.goto(`${ui}/#/playlists`);
        await expect(restoring.page.locator('.session-loading')).toBeVisible();
        await expect(restoring.page.locator('.playlist-page, .discovery-form')).toHaveCount(0);
        assert.ok(restoring.calls.every(call => call.path === '/auth/me'));
        release(false);
        await expect(restoring.page).toHaveURL(/#\/login$/);
        assert.ok(!restoring.calls.some(call => call.path === '/playlists'));
    } finally { release(false); await restoring.context.close(); }
    const { context, page, calls, errors } = await fixturePage();
    try {
        await page.goto(`${ui}/#/historial/${'b'.repeat(24)}`);
        await expect(page).toHaveURL(/#\/login$/);
        await page.locator('#auth-email').fill(user.email);
        await page.locator('#auth-password').fill('FixturePassword1');
        await page.locator('.login__form button[type="submit"]').click();
        await expect(page).toHaveURL(new RegExp(`#/historial/${'b'.repeat(24)}$`));
        await expect(page.locator('.history-page')).toBeVisible();
        assert.ok(calls.find(call => call.path.startsWith('/search-history/')).headers.authorization);
        await page.getByRole('button', { name: 'Buscar', exact: true }).click();
        await expect(page.getByLabel('Fragmento de letra', { exact: true })).toBeVisible();
        await page.getByLabel('Fragmento de letra', { exact: true }).fill('Synthetic authenticated song fragment');
        await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
        await expect.poll(() => calls.filter(call => call.path === '/search-songs').length).toBe(1);
        assert.equal(calls.find(call => call.path === '/search-songs').headers.authorization, 'Bearer fixture-token');
        await page.getByRole('button', { name: 'Historial', exact: true }).click();
        await expect(page.locator('.history-page')).toBeVisible();
        await page.getByRole('button', { name: 'Abrir menú de perfil' }).click();
        await page.getByRole('menuitem', { name: 'Cerrar sesión' }).click();
        await expect(page.locator('.landing')).toBeVisible();
        await expect(page.locator('.discovery-form')).toHaveCount(0);
        assert.equal(await page.evaluate(() => localStorage.getItem('me:token')), null);
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});
