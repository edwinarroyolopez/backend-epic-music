import { randomUUID, createHash } from 'node:crypto';
import { previewSelection, requireEnoughSongs, linkSelection, fail, text } from './playlist-personality-domain.service.js';
import { generatePersonality, authorizedEvidence, REPORT_VERSION } from './playlist-personality-engine.service.js';
import { PlaylistAnalysis } from '../models/playlist-analysis.model.js';
import { assertSelectionProvenance } from './playlist-provenance.service.js';

export function serializeAnalysis(doc, detail = true) {
    return { id: String(doc._id), title: doc.title, sourceMode: doc.sourceMode, sourcePlaylistId: doc.sourcePlaylistId ? String(doc.sourcePlaylistId) : undefined,
        status: doc.status === 'pending' && doc.leaseUntil < new Date() ? 'error' : doc.status,
        totalSongCount: doc.totalCount, processedCount: doc.processedCount, createdAt: doc.createdAt, expiresAt: doc.expiresAt,
        ...(detail && { songs: doc.songs, report: doc.report }) };
}
export async function requireAnalysisStore() {
    if (PlaylistAnalysis.db.readyState !== 1) fail('UNAVAILABLE', 503);
    await PlaylistAnalysis.init();
    const indexes = await PlaylistAnalysis.collection.indexes();
    if (!['requestIds', 'contentHash'].every(key => indexes.some(i => i.unique && i.key.owner === 1 && i.key[key] === 1))) fail('UNAVAILABLE', 503);
}
export async function ownedAnalysis(owner, id) {
    if (!owner) fail('UNAUTHORIZED', 401);
    if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) fail();
    const doc = await PlaylistAnalysis.findOne({ owner, _id: id, expiresAt: { $gt: new Date() } }).maxTimeMS(2000).lean();
    if (!doc) fail('NOT_FOUND', 404);
    return doc;
}

export function createPersonalityService({ callAI, timeoutMs = 18000, reportVersion = REPORT_VERSION } = {}) {
    const guestActive = new Set();
    return async (body, owner, guestKey = 'guest') => {
        assertSelectionProvenance(body);
        if (body?.consent !== true || body?.independentSource !== true) fail('CONSENT_REQUIRED', 400);
        if (typeof body.requestId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(body.requestId)) fail();
        body = { ...body, requestId: body.requestId.toLowerCase() };
        if (!['es', 'en'].includes(body.language)) fail();
        if (body.retryOf !== undefined) {
            if (typeof body.retryOf !== 'string' || !/^[a-f\d-]{24,36}$/i.test(body.retryOf)) fail();
            if (owner && (await ownedAnalysis(owner, body.retryOf)).status !== 'partial') fail('REQUEST_CONFLICT', 409);
        }
        const title = text(body.title || (body.language === 'en' ? 'My selection' : 'Mi selección'), 100, true);
        let selection = await previewSelection(body, owner);
        requireEnoughSongs(selection);
        if (owner) selection = await linkSelection(selection);
        const evidence = owner ? await authorizedEvidence(selection.songs) : [];
        const contentHash = createHash('sha256').update(JSON.stringify({ selection, evidence, title, language: body.language, reportVersion, retryOf: body.retryOf || null })).digest('hex');
        const run = () => generatePersonality(selection, { consent: true, language: body.language, evidence, callAI, timeoutMs: Math.min(timeoutMs, 20000) });
        if (!owner) {
            const key = `${guestKey}:${contentHash}`;
            if (guestActive.has(key)) fail('ANALYSIS_IN_PROGRESS', 409);
            guestActive.add(key);
            try {
                const report = await run();
                return { entry: { id: body.requestId, title, ...selection, report, status: report.status, createdAt: report.createdAt, expiresAt: new Date(Date.now() + 90 * 86400000).toISOString() }, saved: false };
            } finally { guestActive.delete(key); }
        }
        await requireAnalysisStore();
        await PlaylistAnalysis.deleteMany({ owner, expiresAt: { $lte: new Date() } }).maxTimeMS(2000);
        const previous = await PlaylistAnalysis.findOne({ owner, requestIds: body.requestId }).maxTimeMS(2000).lean();
        if (previous && previous.contentHash !== contentHash) fail('REQUEST_CONFLICT', 409);
        let doc = previous || await PlaylistAnalysis.findOne({ owner, contentHash }).maxTimeMS(2000).lean();
        const token = randomUUID(), leaseUntil = new Date(Date.now() + 40000);
        if (!doc) {
            try {
                doc = (await PlaylistAnalysis.create({ owner, requestIds: [body.requestId], contentHash, reportVersion, title,
                    sourceMode: selection.sourceMode, sourcePlaylistId: selection.sourcePlaylistId, songs: selection.songs,
                    status: 'pending', consentAt: new Date(), totalCount: selection.totalSongCount, leaseToken: token, leaseUntil,
                    expiresAt: new Date(Date.now() + 90 * 86400000) })).toObject();
            } catch (error) {
                if (error.code !== 11000) throw error;
                doc = await PlaylistAnalysis.findOne({ owner, contentHash }).maxTimeMS(2000).lean();
                if (!doc) fail('REQUEST_CONFLICT', 409);
            }
        }
        if (!doc.requestIds.includes(body.requestId)) {
            if (doc.requestIds.length >= 100) fail('LIMIT_REACHED', 409);
            try {
                const linked = await PlaylistAnalysis.updateOne({ _id: doc._id, owner, 'requestIds.99': { $exists: false } }, { $addToSet: { requestIds: body.requestId } }).maxTimeMS(2000);
                if (!linked.matchedCount && !await PlaylistAnalysis.exists({ _id: doc._id, owner, requestIds: body.requestId }).maxTimeMS(2000)) fail('LIMIT_REACHED', 409);
            }
            catch (error) { if (error.code === 11000) fail('REQUEST_CONFLICT', 409); throw error; }
        }
        if (doc.report && ['completed', 'partial'].includes(doc.status)) return { entry: serializeAnalysis(doc), saved: true, cached: true };
        if (doc.leaseToken !== token) {
            doc = await PlaylistAnalysis.findOneAndUpdate({ _id: doc._id, owner, status: { $in: ['pending', 'error'] }, leaseUntil: { $lte: new Date() } },
                { $set: { leaseToken: token, leaseUntil, status: 'pending', errorCode: null } }, { returnDocument: 'after' }).maxTimeMS(2000).lean();
            if (!doc) fail('ANALYSIS_IN_PROGRESS', 409);
        }
        try {
            const report = await run();
            const completed = await PlaylistAnalysis.findOneAndUpdate({ _id: doc._id, owner, leaseToken: token, leaseUntil: { $gt: new Date() }, status: 'pending' },
                { $set: { report, status: report.status, processedCount: selection.totalSongCount, completedAt: new Date() }, $unset: { leaseToken: 1, leaseUntil: 1 } }, { returnDocument: 'after' }).maxTimeMS(2000).lean();
            if (!completed) fail('UNAVAILABLE', 503);
            return { entry: serializeAnalysis(completed), saved: true, cached: false };
        } catch (error) {
            await PlaylistAnalysis.updateOne({ _id: doc._id, owner, leaseToken: token }, { $set: { status: 'error', errorCode: 'UNAVAILABLE', leaseUntil: new Date() } }).maxTimeMS(2000).catch(() => {});
            throw error;
        }
    };
}
