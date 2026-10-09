import mongoose from 'mongoose';
import { Artist, artistKeys } from '../models/artist.model.js';
import { displayText, identityKey, matchKey, grams, resolveName, resolveGenre, editDistance } from './search-normalization.js';

const MAX_CANDIDATES = 80;
const projection = 'canonicalName aliases normalizedKey validationStatus';
export async function artistCandidates(value, { prefix = false } = {}) {
    const key = matchKey(value);
    if (!key) return { artists: [], complete: true };
    // Literal indexed range, never an untrusted regular expression.
    const query = prefix ? { searchKeys: { $elemMatch: { $gte: key, $lt: `${key}\uffff` } } } : { searchKeys: key };
    const exact = await Artist.find(query).hint({ searchKeys: 1 }).select(projection).sort({ normalizedKey: 1, _id: 1 }).limit(MAX_CANDIDATES + 1).maxTimeMS(1000).lean();
    if (exact.length > MAX_CANDIDATES) return { artists: exact.slice(0, MAX_CANDIDATES), complete: false };
    const keys = grams(value);
    if (!keys.length || (!prefix && exact.length)) return { artists: exact, complete: true };
    const approximate = await Artist.find({ grams: { $in: keys.slice(0, 32) } }).hint({ grams: 1 }).select(projection)
        .sort({ normalizedKey: 1, _id: 1 }).limit(MAX_CANDIDATES + 1).maxTimeMS(1000).lean();
    const artists = [...new Map([...exact, ...approximate].map(a => [String(a._id), a])).values()];
    return { artists: artists.slice(0, MAX_CANDIDATES), complete: approximate.length <= MAX_CANDIDATES && artists.length <= MAX_CANDIDATES };
}

export async function resolveArtist(value) {
    if (mongoose.connection.readyState !== 1) return { ...resolveName(value, []), available: false };
    try {
        const { artists, complete } = await artistCandidates(value);
        return { ...resolveName(value, artists, { complete }), available: true };
    } catch { return { ...resolveName(value, []), available: false }; }
}

export async function resolveSearchInput({ artist, genre }, { artistResolver = resolveArtist } = {}) {
    const artistResolution = await artistResolver(artist);
    const genreResolution = resolveGenre(genre);
    const original = { artist: artist || null, genre: genre || null };
    const resolved = { artist: artistResolution.value, genre: genreResolution.value };
    const corrections = [];
    for (const [field, resolution] of [['artist', artistResolution], ['genre', genreResolution]]) {
        if (resolution.recognized && original[field] !== resolution.value) corrections.push({ field, original: original[field], suggested: resolution.value, applied: true, source: resolution.source, confidenceBand: 'high' });
        for (const suggested of resolution.candidates) corrections.push({ field, original: original[field], suggested, applied: false, source: resolution.source, confidenceBand: 'uncertain' });
    }
    return {
        input: { original, resolved, corrections, needsConfirmation: corrections.some(c => !c.applied), directoryStatus: artistResolution.available ? 'available' : 'unavailable' },
        artistResolution, genreResolution,
    };
}

export async function suggestArtists(value, limit = 6) {
    const { artists, complete } = await artistCandidates(value, { prefix: true });
    const key = matchKey(value);
    const ranked = artists.map(artist => {
        const keys = [artist.canonicalName, ...artist.aliases].map(matchKey);
        const prefix = keys.some(k => k.startsWith(key));
        const score = Math.max(...keys.map(k => 1 - editDistance(key, k) / Math.max(key.length, k.length, 1)));
        return { artist, prefix, score };
    }).filter(a => a.prefix || a.score >= .7).sort((a, b) => Number(b.prefix) - Number(a.prefix) || b.score - a.score || a.artist.normalizedKey.localeCompare(b.artist.normalizedKey));
    return { artists: ranked.slice(0, limit).map(({ artist }) => ({ id: String(artist._id), canonicalName: artist.canonicalName, validationStatus: artist.validationStatus })), truncated: !complete };
}

export async function acceptIdentifiedArtist(song, { originalArtist, resolution } = {}) {
    if (mongoose.connection.readyState !== 1) return { status: 'unavailable' };
    // Same admission as identification, never a stricter second confidence gate.
    // Only a validated song may create a name; raw user hints cannot do so.
    if (!song || !Number.isFinite(song.modelConfidence) || song.modelConfidence < .6 || song.modelConfidence > 1 ||
        typeof song.title !== 'string' || !song.title.trim() || song.title.length > 200 || typeof song.artist !== 'string') return { status: 'unchanged' };
    const canonicalName = displayText(song.artist);
    if (!canonicalName || canonicalName.length > 200) return { status: 'unchanged' };
    try {
        // Lookup fuzzy/prefix is useful for hints, not for merging the identity
        // of an artist actually returned in a successful search result.
        const name = canonicalName;
        const normalizedKey = identityKey(name);
        const update = { $setOnInsert: { canonicalName: name, ...artistKeys(name), aliases: [], validationStatus: 'model_inferred', source: 'lyrics_identification' }, $inc: { usageCount: 1 } };
        try { await Artist.updateOne({ normalizedKey }, update, { upsert: true, runValidators: true, maxTimeMS: 1000 }); }
        catch (error) {
            if (error.code !== 11000) throw error;
            await Artist.updateOne({ normalizedKey }, { $inc: { usageCount: 1 } }, { maxTimeMS: 1000 });
        }
        // Bounded atomic add only for a pre-existing, unambiguous correction.
        if (resolution?.recognized && resolution.source !== 'catalog_prefix' && identityKey(resolution.value) === normalizedKey && originalArtist && identityKey(originalArtist) !== normalizedKey) {
            const alias = displayText(originalArtist);
            await Artist.updateOne({ normalizedKey, 'aliases.19': { $exists: false } }, {
                $addToSet: { aliases: alias, searchKeys: matchKey(alias), grams: { $each: grams(alias) } },
            }, { maxTimeMS: 1000 });
        }
        return { status: 'saved' };
    } catch { return { status: 'unavailable' }; }
}
