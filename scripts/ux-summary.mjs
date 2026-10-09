// Aggregate measured artifacts only; no inferred scores or automatic PASS labels.
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../ai/ux-ui-awwwards/evidence/',import.meta.url));
const before=JSON.parse(await readFile(`${root}baseline-expanded/metrics.json`));
const after=JSON.parse(await readFile(`${root}final-expanded/metrics.json`));
const comparisons=after.records.map((a,index)=>{
    const b=before.records[index];
    if(a.name!==b.name || a.width!==b.width || a.theme!==b.theme) throw new Error('Mismatched scenarios');
    return {view:a.name,width:a.width,height:a.height,theme:a.theme,
        document:{before:b.documentHeight,after:a.documentHeight,reductionPercent: +(100*(1-a.documentHeight/b.documentHeight)).toFixed(1)},
        scrollToTask:{before:b.scrollToTask,after:a.scrollToTask},
        scrollViewports:{before:b.scrollViewports,after:a.scrollViewports},
        controlsAtFold:{before:b.visibleControls,after:a.visibleControls},
        components:Object.fromEntries(['header','title','hero','form','toolbar','card','row'].map(key=>[key,{before:b[key],after:a[key]}])),
        screenshots:{before:`baseline-expanded/${b.screenshot}`,after:`final-expanded/${a.screenshot}`}};
});
await writeFile(`${root}final/metrics-comparison.json`,JSON.stringify(comparisons,null,2));
const lines=['view,width,height,theme,beforeHeight,afterHeight,reductionPercent,beforeTaskScroll,afterTaskScroll,beforeViewports,afterViewports,beforeVisibleControls,afterVisibleControls'];
for(const r of comparisons) lines.push([r.view,r.width,r.height,r.theme,r.document.before,r.document.after,r.document.reductionPercent,r.scrollToTask.before,r.scrollToTask.after,r.scrollViewports.before.toFixed(2),r.scrollViewports.after.toFixed(2),r.controlsAtFold.before,r.controlsAtFold.after].join(','));
await writeFile(`${root}final/metrics-comparison.csv`,lines.join('\n')+'\n');
for(const r of comparisons.filter(r=>[320,390,1440].includes(r.width)&&r.theme==='dark')) console.log(`${r.view}/${r.width}: doc${r.document.before}→${r.document.after}; scrollTask${r.scrollToTask.before}→${r.scrollToTask.after}; form${r.components.form.before?.height}→${r.components.form.after?.height}; row${r.components.row.before?.height}→${r.components.row.after?.height}; toolbar${r.components.toolbar.before?.height}→${r.components.toolbar.after?.height}`);
const a11y=JSON.parse(await readFile(`${root}final/accessibility.json`));
console.log('Axe scans',a11y.results.length,'violations',a11y.results.reduce((n,r)=>n+r.violations.length,0),'incomplete',a11y.results.reduce((n,r)=>n+r.incomplete.length,0));
console.log('Control contrast',a11y.results.filter(r=>r.controlContrast).map(r=>({name:r.name,...r.controlContrast})));
