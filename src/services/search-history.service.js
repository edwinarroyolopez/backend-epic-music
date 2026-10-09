import { SearchHistory } from '../models/search-history.model.js';
import { withSongLinks } from './song-links.js';

export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const PENDING_MS = 5 * 60 * 1000;
export class HistoryError extends Error {
    constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export const historyId = value => {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new HistoryError('VALIDATION_ERROR');
    return value;
};
export const historyLimit = (value = '20') => {
    if (typeof value !== 'string' || !/^\d{1,2}$/.test(value) || +value < 1 || +value > 50) throw new HistoryError('VALIDATION_ERROR');
    return +value;
};
const cursorFor = doc => Buffer.from(JSON.stringify({ date: new Date(doc.createdAt).toISOString(), id: String(doc._id) })).toString('base64url');
function cursorQuery(cursor) {
    if (cursor === undefined) return {};
    try {
        if (typeof cursor !== 'string' || cursor.length > 200 || !/^[\w-]+$/.test(cursor)) throw new Error();
        const { date, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        historyId(id);
        if (typeof date !== 'string' || new Date(date).toISOString() !== date) throw new Error();
        return { $or: [{ createdAt: { $lt: new Date(date) } }, { createdAt: new Date(date), _id: { $lt: id } }] };
    } catch { throw new HistoryError('VALIDATION_ERROR'); }
}
export function serializeHistory(doc, detail = false) {
    const value = doc.toObject ? doc.toObject() : doc;
    const interrupted = value.status === 'pending' && Date.now() - new Date(value.createdAt).getTime() >= PENDING_MS;
    return {
        id: String(value._id), createdAt: value.createdAt, status: interrupted ? 'error' : value.status,
        input: value.input, song: value.result?.song || null, errorCode: interrupted ? 'INTERRUPTED' : value.errorCode,
        ...(detail && { result: value.result ? { ...withSongLinks(value.result), input: value.input } : null }),
    };
}
export async function listHistory(owner, query) {
    const limit = historyLimit(query.limit);
    const docs = await SearchHistory.find({ owner, expiresAt: { $gt: new Date() }, ...cursorQuery(query.cursor) })
        .select('-result.recommendations -result.ai -result.notice').sort({ createdAt: -1, _id: -1 }).limit(limit + 1).maxTimeMS(1000).lean();
    return { entries: docs.slice(0, limit).map(doc => serializeHistory(doc)), nextCursor: docs.length > limit ? cursorFor(docs[limit - 1]) : null };
}
export async function ownedHistory(owner, id) {
    const doc = await SearchHistory.findOne({ _id: historyId(id), owner, expiresAt: { $gt: new Date() } }).maxTimeMS(1000).lean();
    if (!doc) throw new HistoryError('NOT_FOUND', 404);
    return doc;
}
export async function replaceHistorySong(owner, id, song) {
    const safe = new SearchHistory({ result: { song } }).toObject().result.song;
    const updated = await SearchHistory.updateOne({ _id: historyId(id), owner, status: 'found', expiresAt: { $gt: new Date() } },
        { $set: { 'result.song': safe } }, { runValidators: true, maxTimeMS: 1000 });
    if (updated.matchedCount !== 1) throw new HistoryError('NOT_FOUND', 404);
}
export async function reserveHistory(owner, requestId, input) {
    // Recover abandoned reservations on the next accepted search, so a crashed
    // worker cannot leave an unbounded class of permanently pending rows.
    await SearchHistory.updateMany({ owner, status: 'pending', createdAt: { $lt: new Date(Date.now() - PENDING_MS) } },
        { $set: { status: 'error', errorCode: 'INTERRUPTED' } }).maxTimeMS(1000);
    try {
        const doc = await SearchHistory.create({ owner, requestId, status: 'pending', input, expiresAt: new Date(Date.now() + RETENTION_MS) });
        return { doc, fresh: true };
    } catch (error) {
        if (error.code !== 11000) throw error;
        const doc = await SearchHistory.findOne({ owner, requestId }).maxTimeMS(1000).lean();
        if (!doc) throw error;
        return { doc, fresh: false };
    }
}
export async function finishHistory(doc, { result, input, errorCode = null }) {
    // Casting through the strict model strips all fields outside the snapshot
    // schema, including accidentally forwarded request bodies/provider payloads.
    const safe = new SearchHistory({ input, result }).toObject();
    const status = errorCode ? 'error' : result.found ? 'found' : 'not_found';
    const updated = await SearchHistory.updateOne({ _id: doc._id, owner: doc.owner, status: 'pending' }, {
        $set: { status, input: safe.input, result: safe.result, errorCode },
    }, { runValidators: true, maxTimeMS: 1000 });
    if (updated.modifiedCount !== 1) throw new HistoryError('UNAVAILABLE', 503);
    // Bounded retention by time AND count. Pending reservations are not evicted.
    const old = await SearchHistory.find({ owner: doc.owner, status: { $ne: 'pending' } }).sort({ createdAt: -1, _id: -1 })
        .skip(200).limit(500).select('_id').maxTimeMS(1000).lean();
    if (old.length) await SearchHistory.deleteMany({ owner: doc.owner, _id: { $in: old.map(d => d._id) } }).maxTimeMS(1000);
}
