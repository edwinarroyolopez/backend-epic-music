import { Song, canonicalSongKey } from '../models/song.model.js';

export class SongError extends Error {
    constructor(code = 'SONG_CACHE_UNAVAILABLE', status = 503) { super(code); this.code = code; this.status = status; }
}
export async function requireSongStore(Model = Song) {
    if (Model.db.readyState !== 1) throw new SongError();
    await Model.init();
    const indexes = await Model.collection.indexes();
    if (!indexes.some(index => index.unique && index.key.canonicalKey === 1 && Object.keys(index.key).length === 1)) throw new SongError();
}
export async function resolveSong(input, Model = Song) {
    await requireSongStore(Model);
    if (input.songId != null) {
        if (typeof input.songId !== 'string' || !/^[a-f\d]{24}$/i.test(input.songId)) throw new SongError('VALIDATION_ERROR', 400);
        const doc = await Model.findById(input.songId).maxTimeMS(2000).lean();
        if (!doc) throw new SongError('SONG_NOT_FOUND', 404);
        if (input.title != null && canonicalSongKey({ ...input, edition: input.edition ?? doc.edition }) !== doc.canonicalKey) throw new SongError('SONG_IDENTITY_MISMATCH', 409);
        return doc;
    }
    if ([input.title, input.artist].some(v => typeof v !== 'string' || !v.trim() || v.length > 200) ||
        (input.edition != null && (typeof input.edition !== 'string' || input.edition.length > 200))) throw new SongError('VALIDATION_ERROR', 400);
    const identity = { title: input.title.trim().normalize('NFC'), artist: input.artist.trim().normalize('NFC'), edition: input.edition?.trim().normalize('NFC') || '' };
    const canonicalKey = canonicalSongKey(identity);
    try {
        return await Model.findOneAndUpdate({ canonicalKey }, { $setOnInsert: { ...identity, canonicalKey } },
            { upsert: true, returnDocument: 'after', runValidators: true, maxTimeMS: 2000 }).lean();
    } catch (error) {
        if (error.code !== 11000) throw error;
        const doc = await Model.findOne({ canonicalKey }).maxTimeMS(2000).lean();
        if (!doc) throw new SongError();
        return doc;
    }
}

// Bounded batches contain metadata only; this module cannot invoke providers.
export async function attachSongReferences(songs) {
    const result = [];
    for (let offset = 0; offset < songs.length; offset += 12) {
        result.push(...await Promise.all(songs.slice(offset, offset + 12).map(async song => {
            const doc = await resolveSong(song);
            return { ...song, songId: String(doc._id) };
        })));
    }
    return result;
}
