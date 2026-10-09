import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {expect} from '@playwright/test';

export async function checkMatrix({page,ui,fragment}) {
    const dir=process.env.UX_EVIDENCE_DIR || fileURLToPath(new URL('../../ai/ux-ui-awwwards/evidence/final/',import.meta.url));
    await mkdir(dir,{recursive:true});
    const measurements=[];
    const sizes=[[320,700],[360,780],[375,812],[390,844],[430,932],[768,1024],[1024,768],[1280,800],[1440,900],[1920,1080],[844,390]];
    for(const language of ['es','en']) for(const theme of ['dark','light','custom']) {
        await page.goto(ui);
        await page.evaluate(({language,theme})=>{localStorage.setItem('me:language',JSON.stringify(language));localStorage.setItem('me:theme',JSON.stringify(theme));},{language,theme});
        await page.reload();
        await page.route('**/search-songs',async route=>{
            const response=await route.fetch(); const json=await response.json();
            json.data.song.title='Synthetic extended song title / edición de prueba — '+'Á'.repeat(80);
            json.data.recommendations.forEach((song,index)=>{song.title=`Synthetic long recommendation ${index+1} — ${'音楽'.repeat(30)}`;song.artist='Synthetic extended artist & ensemble';});
            await route.fulfill({response,json});
        });
        await page.locator('#lyrics').fill(fragment);
        await page.locator('.discovery-form .btn--primary').click();
        await expect(page.getByRole('checkbox')).toHaveCount(12);
        await page.unroute('**/search-songs');
        for(const [width,height] of sizes) {
            await page.setViewportSize({width,height});
            for(const route of ['/','/historial','/playlists','/login','/ajustes']) {
                await page.goto(`${ui}/#${route}`);
                await expect(page.locator('h1')).toBeVisible();
                const metrics=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}));
                assert.ok(metrics.documentWidth<=width,`${language}/${theme}/${width}/${route} overflow ${metrics.documentWidth}`);
                measurements.push({language,theme,route,viewport:{width,height},...metrics});
            }
        }
        await page.setViewportSize({width:320,height:700}); await page.goto(`${ui}/#/`);
        await expect(page.getByRole('checkbox')).toHaveCount(12);
        await page.screenshot({path:`${dir}/long-results-${language}-${theme}.png`,fullPage:true,animations:'disabled'});
    }
    await writeFile(`${dir}/responsive-matrix.json`,JSON.stringify({timestamp:new Date().toISOString(),measurements},null,2));
    console.log(`Responsive matrix: ${measurements.length} route/theme/language/viewport checks, zero overflow`);
}
