import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

test('Netlify production/previews support authenticated preflights; unrelated origins rejected', async () => {
    const previous = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = ' https://music.example.test ';
    const app = createApp();
    if (previous === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = previous;
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        for (const origin of [
            'https://musica-epica-ed.netlify.app',
            'https://6ac7e1df36cbba7bc92f8c15--musica-epica-ed.netlify.app',
            'https://deploy-preview-42--musica-epica-ed.netlify.app',
            'https://feature-playlists--musica-epica-ed.netlify.app',
            'http://localhost:3000', 'http://127.0.0.1:3000',
            'http://localhost:5173', 'http://127.0.0.1:5173',
            'https://music.example.test',
        ]) {
            for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
                const response = await fetch(`${base}/playlists`, { method: 'OPTIONS', headers: {
                    Origin: origin, 'Access-Control-Request-Method': method,
                    'Access-Control-Request-Headers': 'authorization,content-type',
                } });
                assert.equal(response.status, 204, origin);
                assert.equal(response.headers.get('access-control-allow-origin'), origin);
                assert.match(response.headers.get('access-control-allow-methods'), new RegExp(method));
                assert.match(response.headers.get('access-control-allow-headers'), /Authorization/i);
                assert.match(response.headers.get('access-control-allow-headers'), /Content-Type/i);
            }
            const response = await fetch(`${base}/playlists`, { headers: { Origin: origin } });
            assert.equal(response.status, 401); // CORS never bypasses JWT auth.
            assert.equal(response.headers.get('access-control-allow-origin'), origin);
        }
        for (const origin of [
            'https://unrelated.netlify.app', 'https://musica-epica-ed.netlify.app.evil.test',
            'https://preview--musica-epica-ed.netlify.app.evil.test',
            'http://musica-epica-ed.netlify.app', 'null',
        ]) {
            const response = await fetch(`${base}/auth/providers`, { headers: { Origin: origin } });
            assert.equal(response.status, 403);
            assert.equal(response.headers.get('access-control-allow-origin'), null);
            assert.equal((await response.json()).error.code, 'CORS_ORIGIN_DENIED');
        }
        assert.equal((await fetch(`${base}/auth/providers`)).status, 200);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
