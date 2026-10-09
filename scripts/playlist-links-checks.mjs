import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const results = [], runId = Date.now();
const checks = [
    ['frontend-epic-music', 'npm', ['test']],
    ['frontend-epic-music', 'npm', ['run', 'lint']],
    ['frontend-epic-music', 'npm', ['run', 'build']],
    ['backend-epic-music', 'npm', ['test']],
    ['backend-epic-music', 'npm', ['run', 'test:e2e']],
    ...(process.argv.includes('--full-ux') ? ['^UX evidence', '^UX accessibility', '^UX matrix'].map(pattern => ['backend-epic-music', 'node', ['--test', `--test-name-pattern=${pattern}`, 'scripts/e2e.mjs']]) : []),
    ['backend-epic-music', 'npm', ['run', 'test:playlist-personality']],
    ['backend-epic-music', 'npm', ['run', 'test:playlist-links']],
    ['frontend-epic-music', 'git', ['diff', '--check']],
    ['backend-epic-music', 'git', ['diff', '--check']],
];
for (const [repo, executable, args] of checks) {
    const started = Date.now(); let output = '';
    // Explicitly disable remote playlist access in general tests; recovery tests inject transport.
    const ux = args.some(a => a.startsWith('--test-name-pattern=')) ? { UX_PHASE: 'final', UX_AXE: '1', UX_FULL: '1', UX_EVIDENCE_DIR: `${root}ai/playlist-links-recovery/evidence/ux-general`, UX_AXE_PATH: `${root}backend-epic-music/node_modules/axe-core/axe.min.js` } : {};
    const child = spawn(executable, args, { cwd: `${root}${repo}`, env: { ...process.env, UX_PHASE: '', UX_AXE: '', UX_FULL: '', ...ux, YOUTUBE_PREVIEW_ENABLED: 'false', YOUTUBE_API_KEY: '' } });
    child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    const summary = output.split('\n').filter(line => /^(# (tests|pass|fail|skipped|cancelled|duration_ms)|Found |dist\/|✓ built|not ok|  (error:|failureType:|location:|expected:|actual:))/.test(line));
    results.push({ repo, command: [executable, ...args].join(' '), ...(Object.keys(ux).length && { environment: ux }), exitCode, elapsedMs: Date.now() - started, summary });
    console.log(JSON.stringify(results.at(-1)));
    const record = JSON.stringify({ date: new Date().toISOString(), scope: 'Local tests only; remote provider/AI transports injected, not remote access evidence', results }, null, 2);
    await writeFile(`${root}ai/playlist-links-recovery/evidence/checks-${runId}.json`, record);
    await writeFile(`${root}ai/playlist-links-recovery/evidence/checks.json`, record);
    if (exitCode) process.exitCode = 1;
}
