import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

export async function auditAccessibility({page,ui,fragment,register}) {
    const source = await readFile(process.env.UX_AXE_PATH || '/tmp/opencode/epic-ux-tools/node_modules/axe-core/axe.min.js','utf8');
    const dir = process.env.UX_EVIDENCE_DIR || fileURLToPath(new URL(`../../ai/ux-ui-awwwards/evidence/${process.env.UX_PHASE || 'final'}/`,import.meta.url));
    await mkdir(dir,{recursive:true});
    const results=[];
    async function scan(name) {
        await page.waitForTimeout(220);
        await page.addScriptTag({content:source});
        const report = await page.evaluate(async () => {
            const result=await window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}});
            return {violations:result.violations, incomplete:result.incomplete.map(r=>({id:r.id, nodes:r.nodes.map(n=>n.target)})),passes:result.passes.length};
        });
        const controlContrast=await page.evaluate(()=>{
            const el=document.querySelector('#lyrics');
            if(!el) return null;
            const style=getComputedStyle(el), root=getComputedStyle(document.documentElement);
            const canvas=document.createElement('canvas'); canvas.width=canvas.height=1;
            const ctx=canvas.getContext('2d');
            const luminance=(color,background)=>{
                ctx.clearRect(0,0,1,1);ctx.fillStyle=background;ctx.fillRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);
                const c=[...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
                return c[0]*.2126+c[1]*.7152+c[2]*.0722;
            };
            const contrast=(fg,bg)=>{const a=luminance(fg,bg),b=luminance(bg,bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
            return {border:contrast(style.borderColor,style.backgroundColor),focus:contrast(root.getPropertyValue('--color-secondary'),style.backgroundColor)};
        });
        const reviewedContrast=await page.evaluate(incomplete=>{
            const targets=incomplete.filter(r=>r.id==='color-contrast').flatMap(r=>r.nodes);
            return targets.map(target=>{
                const el=document.querySelector(target[0]);
                if(!el) return {target,unresolved:true};
                const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
                const ctx=canvas.getContext('2d');
                const parents=[];for(let node=el;node;node=node.parentElement) parents.unshift(node);
                ctx.fillStyle='#fff';ctx.fillRect(0,0,1,1);
                let gradient=false;
                for(const parent of parents){
                    const style=getComputedStyle(parent);
                    ctx.fillStyle=style.backgroundColor;ctx.fillRect(0,0,1,1);
                    if(parent.classList.contains('avatar__fallback')) {
                        // White/light initials on supplied dark presets: the brightest
                        // gradient endpoint is primary; the other mixes 38% black.
                        ctx.fillStyle=style.getPropertyValue('--color-primary');ctx.fillRect(0,0,1,1);gradient=true;
                    }
                }
                const bg=[...ctx.getImageData(0,0,1,1).data].slice(0,3);
                ctx.fillStyle=getComputedStyle(el).color;ctx.fillRect(0,0,1,1);
                const fg=[...ctx.getImageData(0,0,1,1).data].slice(0,3);
                const lum=c=>{const [r,g,b]=c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return r*.2126+g*.7152+b*.0722;};
                const a=lum(fg),b=lum(bg);
                return {target,foreground:fg,background:bg,gradientEndpoint:gradient,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
            });
        },report.incomplete);
        results.push({name,...report,controlContrast,reviewedContrast});
        if(process.env.UX_PHASE==='final') await page.screenshot({path:`${dir}/a11y-${name.replaceAll('/','-')}.png`,animations:'disabled'});
        console.log(`axe ${name}: ${report.violations.map(v=>`${v.id}(${v.nodes.length})`).join(',') || '0 violations'}`);
    }
    for (const language of ['es','en']) for (const theme of ['dark','light','custom']) {
        await page.evaluate(({language,theme})=>{localStorage.setItem('me:language',JSON.stringify(language));localStorage.setItem('me:theme',JSON.stringify(theme));},{language,theme});
        await page.goto(ui); await page.reload();
        await expect(page.locator('#lyrics')).toBeVisible();
        await scan(`${language}/${theme}/home`);
        await page.locator('#lyrics').fill(fragment);
        await page.locator('.discovery-form .btn--primary').click();
        await expect(page.getByRole('checkbox')).toHaveCount(12);
        await scan(`${language}/${theme}/results`);
        for (const route of ['historial','login','ajustes']) {
            await page.goto(`${ui}/#/${route}`);
            await scan(`${language}/${theme}/${route}`);
        }
    }
    await page.evaluate(()=>localStorage.setItem('me:language','"es"')); await page.reload();
    await page.getByRole('radio',{name:/^Personalizado/}).click();
    for (const name of ['Epica','Vinilo','Ocre','Noche']) {
        await page.getByRole('button',{name,exact:true}).click();
        await scan(`preset/${name}`);
    }
    if(process.env.UX_PHASE==='final') {
        await page.getByRole('button',{name:'Epica',exact:true}).click();
        await page.goto(`${ui}/#/login`); await register(page,'axe');
        await page.locator('#lyrics').fill(fragment);
        await page.locator('.discovery-form .btn--primary').click();
        await expect(page.getByRole('checkbox')).toHaveCount(12);
        for(const theme of ['dark','light','custom']) {
            await page.evaluate(theme=>localStorage.setItem('me:theme',JSON.stringify(theme)),theme);
            await page.reload();
            for(const route of ['perfil','cuenta','playlists']) {
                await page.goto(`${ui}/#/${route}`); await scan(`private/${theme}/${route}`);
            }
            await page.goto(`${ui}/#/perfil`);
            await page.getByRole('button',{name:'Editar perfil',exact:true}).click();
            await scan(`private/${theme}/profile-editor`);
            await page.keyboard.press('Escape');
            await page.getByRole('button',{name:'Abrir menú de perfil'}).click();
            await scan(`private/${theme}/menu`);
            await page.keyboard.press('End');
            await expect(page.getByRole('menuitem',{name:/Cerrar sesión/})).toBeFocused();
            await page.keyboard.press('Home');
            await expect(page.getByRole('menuitem',{name:'Buscar',exact:true})).toBeFocused();
            await page.keyboard.press('Escape');
            await page.goto(`${ui}/#/historial`);
            await page.getByRole('button',{name:'Ver Synthetic Source — Test Artist',exact:true}).click();
            await scan(`private/${theme}/preview`);
            await page.getByRole('dialog').locator('.song-card__open').first().click();
            await expect(page.getByRole('dialog').locator('.lyrics-text')).toBeVisible();
            await scan(`private/${theme}/nested-lyrics`);
            await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
        }
    }
    await writeFile(`${dir}/accessibility${process.env.UX_A11Y_BASELINE ? '-before' : ''}.json`,JSON.stringify({timestamp:new Date().toISOString(),results},null,2));
    if (!process.env.UX_A11Y_BASELINE) {
        assert.equal(results.reduce((n,r)=>n+r.violations.length,0),0,'Axe violations: see accessibility.json');
        assert.ok(results.every(r=>!r.controlContrast || (r.controlContrast.border>=3 && r.controlContrast.focus>=3)), 'Input border/focus contrast must be >=3:1');
        assert.ok(results.every(r=>r.reviewedContrast.every(c=>c.ratio>=4.5)), 'Computed contrast review for axe-incomplete nodes');
    }
}
