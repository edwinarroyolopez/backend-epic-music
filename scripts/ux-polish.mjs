import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {expect} from '@playwright/test';

export async function checkPolish({page,ui,fragment}) {
    const dir=fileURLToPath(new URL(`../../ai/ux-ui-awwwards/evidence/${process.env.UX_PHASE || 'final'}/`,import.meta.url));
    await mkdir(dir,{recursive:true});
    const checks=[];
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.goto(`${ui}/#/ajustes`);
    await expect(page.locator('.settings')).toBeVisible();
    await page.waitForURL('**/#/ajustes');
    const url=page.url();
    await page.locator('.skip-link').focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
    assert.equal(page.url(),url,'Skip link must not change hash route');
    await page.evaluate(()=>{
        window.__scrollBehaviors=[];
        const scroll=window.scrollTo.bind(window);
        window.scrollTo=(...args)=>{ window.__scrollBehaviors.push(args[0]?.behavior); scroll(...args); };
    });
    await page.getByRole('button',{name:'Buscar',exact:true}).click();
    assert.ok(!(await page.evaluate(()=>window.__scrollBehaviors)).includes('smooth'));
    await page.locator('#lyrics').fill(fragment);
    await page.getByRole('button',{name:'Buscar canciones similares',exact:true}).click();
    await expect(page.getByRole('checkbox')).toHaveCount(12);
    const timings=[];
    for(let i=0;i<10;i++) timings.push(await page.getByRole('checkbox').nth(i).evaluate(el=>new Promise(resolve=>{
        const start=performance.now(); el.click(); requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)));
    })));
    checks.push({name:'selection-event-to-two-frames-ms',samples:timings,max:Math.max(...timings)});
    assert.ok(Math.max(...timings)<200,'Selection event-to-paint lab budget');
    // Reflow equivalent to a 1280×800 screen at 200% and 400%; not OS zoom.
    for(const [width,height,scale] of [[640,400,200],[320,200,400]]) {
        await page.setViewportSize({width,height});
        await page.goto(`${ui}/#/login`);
        await page.locator('#auth-email').focus();
        await page.keyboard.press('Tab');
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        const focus=await page.evaluate(()=>{
            const r=document.activeElement.getBoundingClientRect();
            return {top:r.top,bottom:r.bottom,height:innerHeight,outline:getComputedStyle(document.activeElement).outlineStyle};
        });
        assert.ok(focus.top>=0&&focus.bottom<=height,`Focused input obscured at ${scale}%`);
        assert.notEqual(focus.outline,'none');
        checks.push({name:`reflow-equivalent-${scale}%`,width,height,focus});
        await page.screenshot({path:`${dir}/reflow-${scale}.png`,animations:'disabled'});
    }
    await page.setViewportSize({width:390,height:844});
    await page.goto(ui);
    await page.locator('#lyrics').fill(fragment);
    await page.route('**/search-songs',route=>route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({success:false,error:'synthetic unavailable'})}));
    await page.getByRole('button',{name:'Buscar canciones similares',exact:true}).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.screenshot({path:`${dir}/error-390.png`,fullPage:true});
    await page.unroute('**/search-songs');
    await page.route('**/search-songs',async route=>{
        await new Promise(resolve=>setTimeout(resolve,1200));
        await route.abort().catch(()=>{});
    });
    await page.getByRole('button',{name:'Buscar canciones similares',exact:true}).click();
    await expect(page.getByRole('button',{name:'Cancelar',exact:true})).toBeVisible();
    await page.screenshot({path:`${dir}/loading-390.png`,fullPage:true});
    await page.getByRole('button',{name:'Cancelar',exact:true}).click();
    await page.screenshot({path:`${dir}/cancelled-390.png`,fullPage:true});
    await writeFile(`${dir}/interaction-checks.json`,JSON.stringify({timestamp:new Date().toISOString(),checks},null,2));
}
