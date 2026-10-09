import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizePlaylistURL, providerCapabilities } from '../src/services/playlist-provider-gate.service.js';
import { createPersonalityService } from '../src/services/playlist-personality.service.js';
test('recognition: allowlisted playlists distinguished from unavailable metadata; never fetch or invoke AI', async () => {
    const previous = globalThis.fetch; let fetches = 0, ai = 0;
    globalThis.fetch = () => { fetches++; throw new Error('External network forbidden'); };
    try {
        const service = createPersonalityService({ callAI: () => { ai++; } });
        for (const url of ['https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n?si=test', 'https://open.spotify.com/intl-es/playlist/3cEYpjA9oz9GiPac4AsH4n', 'https://youtube.com/playlist?list=PL1234567890abc', 'https://music.youtube.com/playlist?list=PL1234567890abc', 'https://www.youtube.com/watch?v=abcdefghijk&list=PL1234567890abc']) {
            const value = recognizePlaylistURL(url); assert.equal(value.url_recognized, true); assert.equal(value.status, 'configuration_required'); assert.equal(value.analysis, false); assert.ok(value.canonicalUrl.startsWith('https://'));
            await assert.rejects(service({ sourceMode: 'link', url, consent: true }), /SOURCE_PROVENANCE_RESTRICTED/);
        }
        for (const url of ['http://youtube.com/playlist?list=PL1234567890abc', 'https://127.0.0.1/playlist?list=PL1234567890abc', 'https://localhost/', 'https://youtube.com.evil.test/playlist?list=PL1234567890abc', 'https://youtube.com@evil.test/playlist?list=PL1234567890abc', 'https://user:secret@youtube.com/playlist?list=PL1234567890abc', 'https://youtube.com:444/playlist?list=PL1234567890abc', 'https://youtu.be/abcdef', 'https://open.spotify.com/track/3cEYpjA9oz9GiPac4AsH4n', 'https://youtube.com/playlist?list=PL1234567890abc&list=PL1234567890abc', 'https://youtube.com/playlist?list=<script>', 'file:///etc/passwd']) assert.throws(() => recognizePlaylistURL(url));
        assert.equal(fetches, 0); assert.equal(ai, 0); assert.equal(providerCapabilities.youtube.import, false);
    } finally { globalThis.fetch = previous; }
});

test('radio retains original URL; video is never treated as a whole playlist', () => {
    for (const url of ['https://www.youtube.com/watch?v=abcdefghijk&list=RDabcdefghijk&start_radio=1', 'https://music.youtube.com/playlist?list=RDabcdefghijk', 'https://youtu.be/abcdefghijk?start_radio=1', 'https://youtube.com/watch?v=abcdefghijk&list=PL1234567890abc&start_radio=1']) {
        const result = recognizePlaylistURL(url);
        assert.equal(result.resourceType, 'youtube_radio'); assert.equal(result.status, 'dynamic_radio'); assert.equal(result.canonicalUrl, url); assert.equal(result.originalUrl, url);
    }
    for (const url of ['https://youtu.be/abcdefghijk', 'https://m.youtube.com/watch?v=abcdefghijk']) assert.equal(recognizePlaylistURL(url).resourceType, 'youtube_video');
    for (const url of ['https://youtube.com:443/playlist?list=PL1234567890abc', 'https://youtube.com/watch?v=abcdefghijk&v=lmnopqrstuv', 'https://youtube.com/watch?v=abcdefghijk&start_radio=1&start_radio=0', 'https://youtube.com/playlist?list=PL1234567890abc%0a', 'https://youtube.com/../playlist?list=PL1234567890abc', 'https://youtube.com\\@evil.test/playlist?list=PL1234567890abc']) assert.throws(() => recognizePlaylistURL(url));
});
