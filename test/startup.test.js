import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import jwt from 'jsonwebtoken';
import { createServer } from 'node:net';

test('without Mongo the real entrypoint serves providers/preflight and honest 503 with CORS', { timeout: 15000 }, async () => {
    const secret = 'startup-test-only';
    const child = spawn(process.execPath, ['src/server.js'], {
        env: { ...process.env, MONGODB_URI: '', PORT: '0', JWT_SECRET: secret },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const origin = 'https://musica-epica-ed.netlify.app';
    try {
        const port = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('HTTP did not start without Mongo')), 8000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited before HTTP readiness')); });
            child.stdout.on('data', chunk => {
                const match = String(chunk).match(/escuchando en puerto (\d+)/);
                if (match) { clearTimeout(timer); resolve(match[1]); }
            });
        });
        const base = `http://127.0.0.1:${port}`;
        const preflight = await fetch(`${base}/auth/providers`, { method: 'OPTIONS', headers: {
            Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'content-type',
        } });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
        const providers = await fetch(`${base}/auth/providers`, { headers: { Origin: origin } });
        assert.equal(providers.status, 200);
        assert.equal(providers.headers.get('access-control-allow-origin'), origin);
        assert.equal((await providers.json()).email, true);
        const health = await fetch(`${base}/health`, { headers: { Origin: origin } });
        assert.equal(health.status, 503);
        assert.equal(health.headers.get('access-control-allow-origin'), origin);
        assert.deepEqual((await health.json()).data, { database: 'disconnected', ready: false });
        const token = jwt.sign({ sub: '000000000000000000000001' }, secret, { expiresIn: '1h' });
        for (const [path, method] of [['/auth/login', 'POST'], ['/auth/signup', 'POST'], ['/auth/me', 'GET'], ['/playlists', 'GET']]) {
            const response = await fetch(`${base}${path}`, { method, headers: { Origin: origin, Authorization: `Bearer ${token}` } });
            assert.equal(response.status, 503);
            assert.equal(response.headers.get('access-control-allow-origin'), origin);
            assert.equal((await response.json()).error.code, 'UNAVAILABLE');
        }
        assert.equal((await fetch(`${base}/playlists`)).status, 401);
    } finally {
        const exit = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        if (child.exitCode === null && child.signalCode === null) await exit;
    }
});

test('Railway assigned port and legacy domain target serve the same CORS/auth app', { timeout: 15000 }, async () => {
    // Reserve an available legacy target for this test, without touching local7000.
    const reservation = createServer().listen(0, '127.0.0.1');
    await new Promise(resolve => reservation.once('listening', resolve));
    const legacyPort = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const child = spawn(process.execPath, ['src/server.js'], {
        env: { ...process.env, PORT: '0', MONGODB_URI: '', RAILWAY_ENVIRONMENT_ID: 'isolated-test', LEGACY_HTTP_PORT: String(legacyPort) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
        const primaryPort = await new Promise((resolve, reject) => {
            let output = '';
            const timer = setTimeout(() => reject(new Error('Both HTTP ports did not start')), 8000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', () => { clearTimeout(timer); reject(new Error('HTTP startup failed')); });
            child.stdout.on('data', chunk => {
                output += String(chunk);
                const match = output.match(/escuchando en puerto (\d+)/);
                if (match && output.includes(`Puerto HTTP compatible con dominio existente: ${legacyPort}`)) {
                    clearTimeout(timer);
                    resolve(Number(match[1]));
                }
            });
        });
        assert.notEqual(primaryPort, legacyPort);
        for (const port of [primaryPort, legacyPort]) {
            const base = `http://127.0.0.1:${port}`;
            const origin = 'https://musica-epica-ed.netlify.app';
            const providers = await fetch(`${base}/auth/providers`, { headers: { Origin: origin } });
            assert.equal(providers.status, 200);
            assert.equal(providers.headers.get('access-control-allow-origin'), origin);
            assert.equal((await providers.json()).email, true);
            const preflight = await fetch(`${base}/auth/login`, { method: 'OPTIONS', headers: {
                Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
            } });
            assert.equal(preflight.status, 204);
            assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
            assert.equal((await fetch(`${base}/playlists`)).status, 401);
            assert.equal((await fetch(`${base}/health`)).status, 503);
        }
    } finally {
        const exit = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        if (child.exitCode === null && child.signalCode === null) await exit;
    }
});
