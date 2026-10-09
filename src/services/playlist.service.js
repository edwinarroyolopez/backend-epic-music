import mongoose from 'mongoose';
import { Playlist } from '../models/playlist.model.js';
import { attachSongReferences } from './song-identity.service.js';

export const LIMITS = { playlists: 100, songs: 500, batch: 100 };
export class PlaylistError extends Error {
    constructor(code, status, message = code) { super(message); this.code = code; this.status = status; }
}
export const invalid = () => { throw new PlaylistError('VALIDATION_ERROR', 400, 'Datos inválidos'); };
export function objectId(value) {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) invalid();
    return value.toLowerCase();
}
export function fields(body, allowed) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) invalid();
}
function text(value, max, required = false) {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid();
    return value.trim();
}
export function metadata(body, creating = false) {
    fields(body, creating ? ['name', 'description', 'songs'] : ['name', 'description']);
    if (!creating && !Object.keys(body).length) invalid();
    const result = {};
    if (creating || body.name !== undefined) result.name = text(body.name, 100, true);
    if (body.description !== undefined) result.description = text(body.description, 1000);
    return result;
}
const normalize = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
export const normalizedKey = (title, artist) => JSON.stringify([normalize(title), normalize(artist)]);
export function songInputs(values, allowEmpty = false) {
    if (!Array.isArray(values) || values.length > LIMITS.batch || (!allowEmpty && !values.length)) invalid();
    return values.map(value => {
        fields(value, ['title', 'artist', 'genre', 'album', 'releaseYear', 'reason', 'originType', 'catalogVerified', 'songId', 'edition']);
        const title = text(value.title, 200, true), artist = text(value.artist, 200, true);
        if (!['identified', 'recommendation'].includes(value.originType)) invalid();
        if (value.catalogVerified !== undefined && value.catalogVerified !== false) invalid();
        const song = { title, artist, originType: value.originType, catalogVerified: false, normalizedKey: normalizedKey(title, artist) };
        if (value.songId != null) song.songId = objectId(value.songId);
        if (value.edition != null) song.edition = text(value.edition, 200);
        if (song.edition) song.normalizedKey = JSON.stringify([normalize(title), normalize(artist), song.edition.normalize('NFC').toLowerCase()]);
        for (const [key, max] of [['genre', 200], ['album', 200], ['reason', 2000]]) {
            if (value[key] != null) song[key] = text(value[key], max);
        }
        if (value.releaseYear != null) {
            if (!Number.isInteger(value.releaseYear) || value.releaseYear < 1850 || value.releaseYear > new Date().getUTCFullYear() + 1) invalid();
            song.releaseYear = value.releaseYear;
        }
        return song;
    });
}
function append(doc, songs) {
    const keys = new Set(doc.songs.map(s => s.normalizedKey));
    let addedCount = 0;
    for (const song of songs) {
        if (keys.has(song.normalizedKey)) continue;
        keys.add(song.normalizedKey);
        doc.songs.push(song);
        addedCount++;
    }
    if (doc.songs.length > LIMITS.songs) throw new PlaylistError('LIMIT_REACHED', 409);
    return { addedCount, skippedCount: songs.length - addedCount };
}
export async function createPlaylist(owner, body) {
    const meta = metadata(body, true);
    const songs = await attachSongReferences(songInputs(body.songs === undefined ? [] : body.songs, true));
    // Each owner has at most 100 unique slots. The unique index enforces the cap
    // even across processes, without a transaction or race-prone count()+insert.
    for (let attempt = 0; attempt < 5; attempt++) {
        const used = new Set((await Playlist.find({ owner }).select('slot').lean()).map(p => p.slot));
        let slot = 0;
        while (used.has(slot)) slot++;
        if (slot >= LIMITS.playlists) throw new PlaylistError('LIMIT_REACHED', 409);
        const doc = new Playlist({ owner, slot, ...meta });
        const counts = append(doc, songs);
        try { await doc.save(); return { doc, ...counts }; }
        catch (error) { if (error.code !== 11000) throw error; }
    }
    throw new PlaylistError('CONFLICT', 409);
}
export async function ownedPlaylist(owner, id) {
    const doc = await Playlist.findOne({ _id: objectId(id), owner });
    if (!doc) throw new PlaylistError('NOT_FOUND', 404);
    return doc;
}
export async function mutatePlaylist(owner, id, mutate) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const doc = await ownedPlaylist(owner, id);
        doc.$where = { owner: doc.owner };
        const extra = mutate(doc) || {};
        try { await doc.save(); return { doc, ...extra }; }
        catch (error) { if (!(error instanceof mongoose.Error.VersionError)) throw error; }
    }
    throw new PlaylistError('CONFLICT', 409);
}
export const addSongs = async (owner, id, songs) => {
    await ownedPlaylist(owner, id);
    const linked = await attachSongReferences(songs);
    return mutatePlaylist(owner, id, doc => append(doc, linked));
};
