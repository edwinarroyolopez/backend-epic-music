import { createHmac, randomBytes } from 'node:crypto';

// Ephemeral one-way fingerprints, never platform content in Song or a database.
// Detect known API rows submitted through another ingestion route, even without IDs.
const secret = randomBytes(32), known = new Map(), ttl = 30 * 60 * 1000;
const fingerprint = s => createHmac('sha256', secret).update(JSON.stringify([s.title, s.artist ?? s.channelTitle].map(v => String(v || '').normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase()))).digest('hex');
export function rejectProvenance() {
    const error = new Error('SOURCE_PROVENANCE_RESTRICTED'); error.code = error.message; error.status = 422; throw error;
}
function prune() { for (const [key, until] of known) if (until <= Date.now()) known.delete(key); }
export function rememberProviderRows(rows) {
    prune();
    for (const row of rows) known.set(fingerprint(row), Date.now() + ttl);
    while (known.size > 10000) known.delete(known.keys().next().value);
    setTimeout(prune, ttl).unref();
}
export function assertIndependentSong(song) {
    if (!song || typeof song !== 'object') return;
    prune();
    if (known.has(fingerprint(song)) || ['provider', 'videoId', 'playlistId', 'url', 'canonicalUrl', 'sourceUrl', 'preview', 'external_urls', 'uri'].some(k => song[k] !== undefined) ||
        ['provenance', 'sourceProvenance'].some(k => song[k] !== undefined && !['user_independent', 'internal_selection'].includes(song[k]))) rejectProvenance();
}
export function assertSelectionProvenance(body) {
    if (body?.sourceMode === 'link' || ['provider', 'url', 'playlistId', 'preview', 'nextPageToken'].some(k => body?.[k] !== undefined)) rejectProvenance();
    const expected = body?.sourceMode === 'internal' ? 'internal_selection' : 'user_independent';
    if (body?.sourceProvenance !== undefined && body.sourceProvenance !== expected) rejectProvenance();
    if (body?.sourceMode === 'manual' && body.sourcePlaylistId) rejectProvenance();
    if (body?.reviewedSongs !== undefined && body.sourceMode !== 'internal') rejectProvenance();
    if (Array.isArray(body?.reviewedSongs)) for (const row of body.reviewedSongs) {
        assertIndependentSong(row);
        if (!row || typeof row !== 'object' || Object.keys(row).some(k => !['title', 'artist', 'genre', 'edition'].includes(k))) rejectProvenance();
    }
    for (const song of Array.isArray(body?.songs) ? body.songs : []) {
        assertIndependentSong(song);
        if (body.sourceMode === 'manual' && ['songId', 'id', '_id'].some(k => song?.[k] !== undefined)) rejectProvenance();
    }
}
