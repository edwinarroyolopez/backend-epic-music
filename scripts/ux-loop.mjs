// Small evidence runner. Never marks visual review as passed automatically.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const phase = process.argv[2];
if (!/^(loop-\d{2}|final)$/.test(phase || '')) throw new Error('Expected loop-NN or final');
const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = `${root}ai/ux-ui-awwwards/evidence/${phase}`;
await mkdir(dir, { recursive:true });
const commands = [
    ['frontend-epic-music','npm',['test']],
    ['frontend-epic-music','npm',['run','lint']],
    ['frontend-epic-music','npm',['run','build']],
    ...(phase==='final' ? [['backend-epic-music','npm',['test']]] : []),
    ...(phase==='final' ? ['^(browser|search intelligence|history|incomplete artist|artist persistence|music details|shared tables|recommendation lyrics)', '^UX evidence', '^UX accessibility', '^UX (search|modal|preferences|polish|profile)', '^UX matrix'].map(pattern=>
        ['backend-epic-music','node',['--test',`--test-name-pattern=${pattern}`,'scripts/e2e.mjs']]) :
        [['backend-epic-music','node',['--test',`--test-name-pattern=${process.env.UX_TESTS || 'UX evidence'}`, 'scripts/e2e.mjs']]]),
    ['frontend-epic-music','git',['diff','--check']],
    ['backend-epic-music','git',['diff','--check']],
];
let log = await readFile(`${dir}/commands.log`, 'utf8').catch(() => '');
log += `\nATTEMPT ${new Date().toISOString()}\n`;
let results = [];
for (const [cwd,command,args] of commands) {
    const run = spawnSync(command,args,{cwd:`${root}${cwd}`,env:{...process.env,UX_PHASE:phase},encoding:'utf8',timeout:240000});
    log += `\n${cwd}: ${command} ${args.join(' ')}\nEXIT ${run.status}\n${run.stdout || ''}${run.stderr || ''}`;
    results.push({cwd, command:`${command} ${args.join(' ')}`,exit:run.status});
    await writeFile(`${dir}/commands.log`, log);
    console.log(`${cwd}: ${command} ${args.join(' ')} → ${run.status}`);
    if (run.status !== 0) { console.error(run.stdout,run.stderr); process.exit(1); }
}
const baseline = JSON.parse(await readFile(`${root}ai/ux-ui-awwwards/evidence/baseline/metrics.json`));
const after = JSON.parse(await readFile(`${dir}/metrics.json`));
const rows = after.records.filter(r=>r.theme==='dark').map(r=>{
    const b=baseline.records.find(x=>x.name===r.name&&x.width===r.width&&x.theme===r.theme);
    return b ? `|${r.name}|${r.width}|${b.documentHeight}|${r.documentHeight}|${((1-r.documentHeight/b.documentHeight)*100).toFixed(1)}%|${r.documentWidth>r.width?'FAIL':'none'}|` : '';
});
await writeFile(`${dir}/EVIDENCE.md`, `# ${phase} — evidence\n\nTimestamp: ${new Date().toISOString()}\n\nHypothesis/scope/acceptance: ../../03_MASTER_LOOP_PLAN.md and ../../04_LOOPS_LOG.md.\nAPI contracts unchanged; synthetic fixtures only.\n\n## Commands\n${results.map(r=>`- ${r.cwd}: \`${r.command}\` — exit ${r.exit}`).join('\n')}\n\n## Before/after document height\n|View|Width|Before|After|Reduction|Overflow|\n|---|---|---|---|---|---|\n${rows.join('\n')}\n\nRaw component geometry and screenshots: metrics.json and linked PNGs.\nAutomated gates completed; visual review and loop closure recorded separately in LOG.\n`);
