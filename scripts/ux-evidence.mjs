// Executed by the existing isolated integration harness; only synthetic records.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

export async function collectUX({ page, ui, register, fragment }) {
    const phase = process.env.UX_PHASE;
    assert.match(phase, /^(baseline|loop-\d{2}|final)$/);
    const folder = `${phase}${process.env.UX_EXPANDED ? '-expanded' : ''}`;
    const dir = process.env.UX_EVIDENCE_DIR || fileURLToPath(new URL(`../../ai/ux-ui-awwwards/evidence/${folder}/`, import.meta.url));
    await mkdir(dir, { recursive: true });
    const records = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const sizes = process.env.UX_FULL ? [[320,700],[360,780],[375,812],[390,844],[430,932],[768,1024],[1024,768],[1280,800],[1440,900],[1920,1080],[844,390]] : [[320,700],[390,844],[1440,900]];
    const capture = async (name, theme = 'dark') => {
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await page.waitForTimeout(280);
        const metrics = await page.evaluate(name => {
            const rect = selector => {
                const el = document.querySelector(selector);
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { top: Math.round(r.top + scrollY), height: Math.round(r.height), bottom: Math.round(r.bottom + scrollY), fontSize: getComputedStyle(el).fontSize };
            };
            const cta = rect('.discovery-form button[type="submit"], .discovery-form .btn--primary');
            const firstTask = rect(({home:'.discovery-form .btn--primary',results:'.song-card',selection:'.selection-toolbar .btn--primary',history:'.data-table tbody a',login:'.login__form button[type="submit"]',settings:'.theme-option',profile:'.profile__edit-button',account:'.account .btn',playlists:'.page__header .btn--primary','playlists-guest':'main .btn','playlist-detail':'.page__header .btn','save-modal':'.modal__dialog button[type="submit"]','lyrics-modal':'.lyrics-text'})[name] || 'main button');
            return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
                header: rect('.header'), title: rect('h1'), hero: rect('.hero'), form: rect('.discovery-form'), toolbar: rect('.selection-toolbar'), card: rect('.song-card'), row: rect('tbody tr'),
                cta, firstTask, scrollToTask: firstTask ? Math.max(0, firstTask.top + Math.min(firstTask.height,44) - innerHeight) : null,
                mainPadding: getComputedStyle(document.querySelector('main')).padding,
                scrollViewports: Math.max(0,document.documentElement.scrollHeight-innerHeight)/innerHeight,
                visibleControls: [...document.querySelectorAll('main button, main input, main textarea, main a')].filter(el => { const r = el.getBoundingClientRect(); return r.height && r.top >= 0 && r.bottom <= innerHeight; }).length };
        },name);
        const file = `${name}-${metrics.width}-${theme}.png`;
        await page.screenshot({ path: `${dir}/${file}`, fullPage: true, animations: 'disabled' });
        records.push({ name, theme, ...metrics, screenshot: file });
        // Baseline records defects; implementation stages assert no new overflow.
        if (phase !== 'baseline') assert.ok(metrics.documentWidth <= metrics.width, `${name}/${metrics.width}: horizontal overflow ${metrics.documentWidth}`);
    };
    try {
        for (const [width,height] of sizes) {
            await page.setViewportSize({ width,height });
            await page.goto(ui);
            await expect(page.locator('#lyrics')).toBeVisible();
            await capture('home');
            await page.locator('#lyrics').fill(fragment);
            await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
            await expect(page.getByRole('checkbox')).toHaveCount(12);
            await capture('results');
            await page.getByRole('checkbox').first().check();
            await capture('selection');
            await page.goto(`${ui}/#/historial`);
            await expect(page.locator('tbody tr').first()).toBeVisible();
            await capture('history');
            await page.goto(`${ui}/#/playlists`);
            await capture('playlists-guest');
            await page.goto(`${ui}/#/login`);
            await expect(page.locator('#auth-email')).toBeVisible();
            await capture('login');
            await page.goto(`${ui}/#/ajustes`);
            await capture('settings');
        }
        // Stable clean context for deterministic private records.
        await page.setViewportSize({ width: 390,height: 844 });
        await page.goto(`${ui}/#/login`);
        await register(page, 'ux');
        await page.locator('#lyrics').fill(fragment);
        await page.getByRole('button', { name: 'Buscar canciones similares', exact: true }).click();
        await expect(page.getByRole('checkbox')).toHaveCount(12);
        await page.getByRole('checkbox').first().check();
        await page.getByRole('checkbox').nth(1).check();
        await page.getByRole('button', { name: 'Guardar selección', exact: true }).click();
        await page.getByRole('textbox', { name: 'Nombre de playlist', exact: true }).fill('Sesión de prueba');
        await capture('save-modal');
        await page.getByRole('button', { name: 'Crear con selección' }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        for (const [width,height] of process.env.UX_FULL ? sizes : [[390,844],[1440,900]]) {
            await page.setViewportSize({width,height});
            for (const [name,route] of [['profile','perfil'],['account','cuenta'],['playlists','playlists']]) {
                await page.goto(`${ui}/#/${route}`);
                await expect(page.locator('h1')).toBeVisible();
                if (route === 'playlists') await expect(page.getByRole('link', {name:'Sesión de prueba',exact:true})).toBeVisible();
                await capture(name);
            }
            await page.getByRole('link', {name:'Sesión de prueba',exact:true}).click();
            await expect(page.locator('.playlist-songs > li')).toHaveCount(2);
            await capture('playlist-detail');
            await page.locator('.song-card__open').first().click();
            await expect(page.locator('.lyrics-text')).toBeVisible();
            await capture('lyrics-modal');
            await page.keyboard.press('Escape');
        }
        for (const theme of ['light','custom','dark']) {
            await page.setViewportSize({width:390,height:844});
            await page.goto(`${ui}/#/ajustes`);
            await page.getByRole('radio', {name: new RegExp(`^${{light:'Claro',custom:'Personalizado',dark:'Oscuro'}[theme]}`)}).click();
            await capture('settings',theme);
            await page.goto(ui);
            await capture('home',theme);
        }
        if(process.env.UX_EXPANDED) {
            await page.setViewportSize({width:390,height:844});
            await page.goto(ui);
            await page.locator('#lyrics').fill(fragment);
            await page.route('**/search-songs',route=>route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({success:false,error:'synthetic unavailable'})}));
            await page.locator('.discovery-form .btn--primary').click();
            await expect(page.getByRole('alert')).toBeVisible();
            await capture('error');
            await page.unroute('**/search-songs');
            await page.route('**/search-songs',async route=>{await new Promise(resolve=>setTimeout(resolve,1500));await route.abort().catch(()=>{});});
            await page.locator('.discovery-form .btn--primary').click();
            await expect(page.getByRole('button',{name:'Cancelar',exact:true})).toBeVisible();
            await capture('loading');
            await page.getByRole('button',{name:'Cancelar',exact:true}).click();
            await capture('cancelled');
            await page.unroute('**/search-songs');
        }
        assert.deepEqual(errors, []);
    } finally {
        await writeFile(`${dir}/metrics.json`, JSON.stringify({ phase:folder, browser: page.context().browser().version(), timestamp: new Date().toISOString(), records, errors },null,2));
    }
    console.log(`UX ${phase}: ${records.length} captures/measurements; ${errors.length} runtime errors`);
}
