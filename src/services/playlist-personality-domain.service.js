import { canonicalSongKey } from '../models/song.model.js';
import { attachSongReferences } from './song-identity.service.js';
import { ownedPlaylist } from './playlist.service.js';
import { assertIndependentSong, assertSelectionProvenance } from './playlist-provenance.service.js';

export class PersonalityError extends Error {
    constructor(code = 'VALIDATION_ERROR', status = 400) { super(code); this.code = code; this.status = status; }
}
export const fail = (code, status) => { throw new PersonalityError(code, status); };
export function text(value, max = 200, required = false) {
    if (typeof value !== 'string' || value.length > max || /[<>\p{Cc}]/u.test(value) || (required && !value.trim())) fail();
    return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}
export function normalizeSongs(values, sourceMode = 'manual') {
    const limit = Math.min(500, Math.max(2, Number(process.env.PERSONALITY_MAX_SONGS) || 500));
    if (!Array.isArray(values) || values.length > limit) fail();
    const seen = new Set();
    return values.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
        assertIndependentSong(value);
        const song = { title: text(value.title, 200, true), artist: text(value.artist, 200, true), edition: text(value.edition ?? ''), genre: text(value.genre ?? ''), index,
            provenance: sourceMode === 'manual' ? 'user_independent' : 'internal_selection', catalogVerified: false };
        const key = canonicalSongKey(song);
        song.duplicate = seen.has(key); seen.add(key);
        return song;
    });
}
export async function previewSelection(body, owner) {
    assertSelectionProvenance(body);
    if (!body || !['manual', 'internal'].includes(body.sourceMode)) fail();
    let values = body.songs;
    if (body.sourceMode === 'internal') {
        if (!owner) fail('UNAUTHORIZED', 401);
        // Never trust client-supplied songs, owner or IDs for an internal selection.
        values = (await ownedPlaylist(owner, body.sourcePlaylistId)).songs;
        // Verify the stored origin before accepting review edits. An edit is not a new origin.
        normalizeSongs(values, 'internal');
        if (body.reviewedSongs !== undefined) {
            if (!Array.isArray(body.reviewedSongs) || body.reviewedSongs.length !== values.length) fail();
            values = body.reviewedSongs;
        }
    }
    const songs = normalizeSongs(values, body.sourceMode);
    return { sourceMode: body.sourceMode, ...(body.sourceMode === 'internal' && { sourcePlaylistId: body.sourcePlaylistId }), songs,
        totalSongCount: songs.length, uniqueSongCount: songs.filter(s => !s.duplicate).length };
}
export function requireEnoughSongs(selection) {
    if (selection.uniqueSongCount < 2) fail('INSUFFICIENT_SONGS', 400);
}
export async function linkSelection(selection) {
    return { ...selection, songs: await attachSongReferences(selection.songs) };
}
