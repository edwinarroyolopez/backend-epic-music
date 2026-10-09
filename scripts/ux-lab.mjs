// Production-only local Lighthouse comparison; never connects to production/AI.
import {createApp} from '../src/app.js';
import {chromium} from '@playwright/test';
import {preview} from '../../frontend-epic-music/node_modules/vite/dist/node/index.js';
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
const tools=process.env.UX_TOOLS_DIR || '/tmp/opencode/epic-ux-tools/node_modules';
const {default:lighthouse}=await import(pathToFileURL(`${tools}/lighthouse/core/index.js`));
const {launch}=await import(pathToFileURL(`${tools}/chrome-launcher/dist/index.js`));
const root=fileURLToPath(new URL('../../',import.meta.url));
const stage=process.argv[2] || 'final';
if (!['baseline','final'].includes(stage)) throw new Error('Expected baseline or final');
const appRoot=stage==='baseline' ? (process.env.UX_BASELINE_ROOT || '/tmp/opencode/epic-ux-baseline') : `${root}frontend-epic-music`;
const dir=`${root}ai/ux-ui-awwwards/evidence/${stage}`;
await mkdir(dir,{recursive:true});
const unavailable=()=>{throw new Error('External provider disabled in UX lab');};
const api=createApp({search:unavailable,lyrics:unavailable}).listen(0,'127.0.0.1');
await new Promise(resolve=>api.once('listening',resolve));
let server,chrome;
try {
    const build=spawnSync('npm',['run','build'],{cwd:appRoot,env:{...process.env,VITE_API_URL:`http://127.0.0.1:${api.address().port}`},encoding:'utf8'});
    await writeFile(`${dir}/lab-build.log`,build.stdout+build.stderr);
    if(build.status!==0) throw new Error(`Build exit ${build.status}`);
    server=await preview({root:appRoot,preview:{host:'127.0.0.1',port:0},logLevel:'error'});
    const base=server.resolvedUrls.local[0];
    chrome=await launch({chromePath:chromium.executablePath(),chromeFlags:['--headless','--no-sandbox','--disable-dev-shm-usage']});
    const summaries=[];
    for(const [name,route] of [['home','/'],['settings','/ajustes'],['login','/login']]) {
        const result=await lighthouse(`${base}#${route}`,{port:chrome.port,onlyCategories:['performance','accessibility'],output:['json','html'],logLevel:'error'});
        await writeFile(`${dir}/lighthouse-${name}.json`,result.report[0]);
        await writeFile(`${dir}/lighthouse-${name}.html`,result.report[1]);
        const {audits,categories}=result.lhr;
        const summary={name,performance:categories.performance.score*100,accessibility:categories.accessibility.score*100,
            lcp:audits['largest-contentful-paint'].numericValue,cls:audits['cumulative-layout-shift'].numericValue,tbt:audits['total-blocking-time'].numericValue,
            version:result.lhr.lighthouseVersion, settings:result.lhr.configSettings};
        summaries.push(summary);
        console.log(stage,name,JSON.stringify({performance:summary.performance,accessibility:summary.accessibility,lcp:summary.lcp,cls:summary.cls,tbt:summary.tbt}));
    }
    await writeFile(`${dir}/lab-summary.json`,JSON.stringify({stage,timestamp:new Date().toISOString(),summaries},null,2));
} finally {
    await chrome?.kill();
    if(server) await new Promise(resolve=>server.httpServer.close(resolve));
    await new Promise(resolve=>api.close(resolve));
}
