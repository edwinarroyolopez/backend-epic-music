// Reproducible local acceptance ledger. Logs retain only aggregate outcomes,
// never provider payloads, tokens, database URIs or synthetic account credentials.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = `${root}ai/playlist-personality/evidence/final`;
await mkdir(dir, { recursive: true });
const checks = [
    ['frontend-epic-music', 'npm', ['test']],
    ['frontend-epic-music', 'npm', ['run', 'lint']],
    ['frontend-epic-music', 'npm', ['run', 'build']],
    ['backend-epic-music', 'npm', ['test']],
    ['backend-epic-music', 'npm', ['run', 'test:e2e']],
    ['backend-epic-music', 'node', ['--test', 'scripts/personality-e2e.mjs']],
    ['backend-epic-music', 'node', ['--test', 'scripts/personality-flow.mjs']],
    ['backend-epic-music', 'node', ['--test', 'scripts/personality-acceptance.mjs']],
    ['backend-epic-music', 'node', ['--test', 'scripts/personality-ux.mjs']],
    ['frontend-epic-music', 'git', ['diff', '--check']],
    ['backend-epic-music', 'git', ['diff', '--check']],
];
const results = [];
const runId = Date.now();
for (const [repo, executable, args] of checks) {
    const start = Date.now(); let output = '';
    const child = spawn(executable, args, { cwd: `${root}${repo}`, env: process.env });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    const summary = output.split('\n').filter(line => /^(# (tests|pass|fail|skipped|cancelled|duration_ms)|Found |dist\/|✓ built|not ok)/.test(line));
    const result = { repo, command: [executable, ...args].join(' '), exitCode, elapsedMs: Date.now() - start, summary };
    results.push(result); console.log(JSON.stringify(result));
    await writeFile(`${dir}/checks-${runId}.json`, JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
    await writeFile(`${dir}/checks.json`, JSON.stringify({ date: new Date().toISOString(), testType: 'TEST_SINTETICO; local browser/Express/Mongo real', results }, null, 2));
    if (exitCode) { process.exitCode = exitCode; break; }
}
