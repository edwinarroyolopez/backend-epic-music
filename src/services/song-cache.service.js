import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Song, songSummary, songIdentityPart } from '../models/song.model.js';
import { resolveSong, SongError } from './song-identity.service.js';
import { lookupLyrics } from './lyrics.service.js';
import { analyzeLyricsEmotions, emptyEmotionAnalysis, EMOTION_VERSION, EMOTION_CODES } from './emotions.service.js';
import { createTransientLyricsStore } from './transient-lyrics.store.js';

// Only trusted server adapters may supply a documented source/record grant.
// This gate governs persistent storage, not the existing on-demand reader.
export const restrictedStorage = () => ({ authorized: false, reference: null });
export const lrclibTransientDelivery = data => data.source?.name === 'LRCLIB';
const defaults = { leaseMs: 30000, workMs: 12000, waitMs: 1500, pollMs: 40, retryMs: 30000 };
const bump = (metrics, name) => { if (metrics) metrics[name] = (metrics[name] || 0) + 1; };
const manuallyRetryable = status => ['not_found', 'rights_restricted'].includes(status);
const lyricsRefetchAt = (lyrics, retryMs) => manuallyRetryable(lyrics.status)
    ? new Date(new Date(lyrics.completedAt || 0).getTime() + retryMs) : lyrics.retryAt;

export async function claimSongWork(Model, doc, stage, { now, leaseMs, metrics }) {
    const token = randomUUID();
    const old = doc[stage];
    const filter = { _id: doc._id, [`${stage}.status`]: old.status, [`${stage}.lease.token`]: old.lease?.token ?? null,
        [`${stage}.attemptCount`]: old.attemptCount };
    if (stage === 'emotionAnalysis') {
        filter['lyrics.contentVersion'] = doc.lyrics.contentVersion;
        filter['lyrics.status'] = doc.lyrics.status;
        filter['lyrics.lease.token'] = null;
    } else {
        // A process without the transient body must not refetch while another
        // process is analyzing it. Both stage claims fence against each other.
        filter['emotionAnalysis.status'] = doc.emotionAnalysis.status;
        filter['emotionAnalysis.lease.token'] = doc.emotionAnalysis.lease?.token ?? null;
        if (doc.emotionAnalysis.status === 'in_progress' && doc.emotionAnalysis.lease?.expiresAt) {
            filter['emotionAnalysis.lease.expiresAt'] = { $lte: now };
        }
    }
    const fields = { [`${stage}.status`]: 'in_progress', [`${stage}.lease`]: { token, expiresAt: new Date(now.getTime() + leaseMs) } };
    if (stage === 'lyrics') Object.assign(fields, { 'lyrics.lookupAttempted': true, 'lyrics.firstAttemptAt': old.firstAttemptAt || now });
    const claimed = await Model.findOneAndUpdate(filter, { $set: fields, $inc: { [`${stage}.attemptCount`]: 1 } }, { returnDocument: 'after', maxTimeMS: 2000 }).lean();
    bump(metrics, claimed ? 'concurrentClaimsWon' : 'concurrentClaimsLost');
    return claimed;
}
export async function commitSongWork(Model, doc, stage, fields, metrics) {
    // Validate cross-field invariants on the proposed complete document, because
    // Mongo update validators alone do not execute document validation hooks.
    const proposed = Model.hydrate(doc);
    proposed.set({ ...fields, [`${stage}.lease`]: null });
    await proposed.validate();
    const filter = { _id: doc._id, [`${stage}.status`]: 'in_progress', [`${stage}.lease.token`]: doc[stage].lease.token };
    if (stage === 'emotionAnalysis') filter['lyrics.contentVersion'] = doc.lyrics.contentVersion;
    const result = await Model.updateOne(filter, { $set: { ...fields, [`${stage}.lease`]: null } }, { runValidators: true, maxTimeMS: 2000 });
    if (result.modifiedCount !== 1) bump(metrics, 'staleWriteRejected');
    return result.modifiedCount === 1;
}
async function boundedWork(fn, workMs) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('WORK_TIMEOUT')); }, workMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => fn(controller.signal)), timeout]); }
    finally { clearTimeout(timer); }
}
export function songDetail(doc, cacheHit = true, { current = new Date(), retryMs = defaults.retryMs, transientText = null, transientPermitted = true } = {}) {
    const analysis = doc.emotionAnalysis;
    const refetchAt = lyricsRefetchAt(doc.lyrics, retryMs);
    const retryAt = refetchAt || analysis.retryAt;
    const text = doc.lyrics.status === 'available' ? doc.lyrics.text : doc.lyrics.status === 'transient' ? transientText : null;
    const status = text ? 'available' : doc.lyrics.status === 'transient' ? (transientPermitted ? 'in_progress' : 'rights_restricted') : doc.lyrics.status;
    return { ...songSummary(doc), status, lyrics: text,
        lyricsStorage: doc.lyrics.status === 'available' ? 'persistent' : doc.lyrics.status === 'transient' ? 'transient' : 'none',
        source: doc.lyrics.source, cacheHit, cacheState: doc.lyrics.status,
        lyricsRefetchAt: refetchAt || null,
        retryAfter: status === 'in_progress' || analysis.status === 'in_progress' ? 1 : retryAt ? Math.max(0, Math.ceil((new Date(retryAt) - current) / 1000)) : null,
        emotions: doc.emotions || [], emotionAnalysis: { status: analysis.status, method: analysis.method, scope: analysis.scope,
            scale: analysis.scale, version: analysis.version, sourceContentVersion: analysis.sourceContentVersion,
            sampled: analysis.sampled, provider: analysis.provider, model: analysis.model, analyzedAt: analysis.analyzedAt, retryAt: analysis.retryAt },
    };
}

export function createSongCache({ Model = Song, lookup = lookupLyrics, storagePolicy = restrictedStorage,
    transientPolicy = lrclibTransientDelivery, transientTtlMs = 300000, maxTransientEntries = 100,
    analyze = analyzeLyricsEmotions, analysisVersion = EMOTION_VERSION, metrics, now = () => new Date(), ...timing } = {}) {
    const config = { ...defaults, ...timing };
    if (config.leaseMs <= config.workMs) throw new Error('Lease must exceed work budget');
    const transient = createTransientLyricsStore({ ttlMs: transientTtlMs, maxEntries: maxTransientEntries, now });
    const localAcquisitions = new Map();
    const permitsTransient = doc => transientPolicy({ title: doc.title, artist: doc.artist, edition: doc.edition, source: doc.lyrics.source }, doc) === true;
    const analysisBusy = doc => doc.emotionAnalysis.status === 'in_progress' && new Date(doc.emotionAnalysis.lease?.expiresAt || 0) > now();
    async function acquireLyrics(doc) {
        const key = String(doc._id);
        // Mongo may expose a completed transient state before its acknowledgement
        // reaches this worker and the body is published locally. Join that work
        // instead of mistaking the acknowledgement window for an expired body.
        if (localAcquisitions.has(key)) return localAcquisitions.get(key);
        const work = acquireLyricsWork(doc);
        localAcquisitions.set(key, work);
        try { return await work; }
        finally { if (localAcquisitions.get(key) === work) localAcquisitions.delete(key); }
    }
    async function acquireLyricsWork(doc) {
        const claimed = await claimSongWork(Model, doc, 'lyrics', { now: now(), leaseMs: config.leaseMs, metrics });
        if (!claimed) return;
        let fields, transientResult = null;
        try {
            const data = await boundedWork(signal => lookup({ title: doc.title, artist: doc.artist, edition: doc.edition }, { signal }), config.workMs);
            if (!['available', 'not_found', 'instrumental'].includes(data?.status)) throw new Error('INVALID_PROVIDER_RESULT');
            if (songIdentityPart(data.title) !== songIdentityPart(doc.title) || songIdentityPart(data.artist) !== songIdentityPart(doc.artist) ||
                songIdentityPart(data.edition || '') !== songIdentityPart(doc.edition || '')) throw new Error('IDENTITY_MISMATCH');
            const grant = storagePolicy(data, doc);
            let status = data.status;
            if (status === 'available') {
                if (typeof data.lyrics !== 'string' || !data.lyrics.trim() || data.lyrics.length > 60000) throw new Error('INVALID_TEXT');
                if (grant?.authorized !== true || typeof grant.reference !== 'string' || !grant.reference.trim()) {
                    status = transientPolicy(data, doc) === true ? 'transient' : 'rights_restricted';
                }
            }
            const available = status === 'available';
            const hasContent = available || status === 'transient';
            const contentVersion = hasContent ? createHash('sha256').update(data.lyrics).digest('hex') : null;
            if (status === 'transient') transientResult = { text: data.lyrics, version: contentVersion };
            fields = { 'lyrics.status': status, 'lyrics.completedAt': now(), 'lyrics.source': data.source,
                'lyrics.text': available ? data.lyrics : null, 'lyrics.rights': available ? { authorized: true, reference: grant.reference } : null,
                'lyrics.contentVersion': contentVersion, 'lyrics.lastErrorCode': null, 'lyrics.retryAt': null };
            // Fetching the same transient body again must not reset valid AI.
            if (!hasContent || claimed.emotionAnalysis.sourceContentVersion !== contentVersion) {
                fields.emotions = [];
                fields.emotionAnalysis = { ...emptyEmotionAnalysis(hasContent ? 'not_started' : 'not_applicable').emotionAnalysis,
                    version: null, sourceContentVersion: null, attemptCount: claimed.emotionAnalysis.attemptCount, lease: null };
            }
        } catch (error) {
            const backoff = Math.min(3600000, config.retryMs * 2 ** Math.min(claimed.lyrics.attemptCount - 1, 7));
            fields = { 'lyrics.status': 'temporary_error', 'lyrics.completedAt': now(), 'lyrics.lastErrorCode': 'LYRICS_UNAVAILABLE',
                'lyrics.retryAt': new Date(now().getTime() + Math.max(backoff, error.retryAfterMs || 0)) };
        }
        if (await commitSongWork(Model, claimed, 'lyrics', fields, metrics)) {
            if (transientResult) transient.put(doc._id, transientResult.version, transientResult.text);
            else transient.delete(doc._id);
            return transientResult;
        }
    }
    async function acquireAnalysis(doc, lyricsText) {
        const claimed = await claimSongWork(Model, doc, 'emotionAnalysis', { now: now(), leaseMs: config.leaseMs, metrics });
        if (!claimed) return;
        let result;
        try {
            result = await boundedWork(signal => analyze({ title: doc.title, artist: doc.artist, lyrics: lyricsText }, { signal }), config.workMs);
            const status = result?.emotionAnalysis?.status, values = result?.emotions;
            if (!['estimated', 'insufficient_evidence', 'unavailable'].includes(status)) throw new Error('INVALID_ANALYSIS');
            if (status === 'estimated' && (!Array.isArray(values) || values.length !== 3 || new Set(values.map(v => v?.code)).size !== 3 ||
                values.some(v => !EMOTION_CODES.includes(v?.code) || !Number.isInteger(v.score) || v.score < 1 || v.score > 100) ||
                values.reduce((sum, v) => sum + v.score, 0) !== 100)) throw new Error('INVALID_ANALYSIS');
        } catch { result = emptyEmotionAnalysis('unavailable'); }
        const meta = result.emotionAnalysis;
        await commitSongWork(Model, claimed, 'emotionAnalysis', {
            emotions: meta.status === 'estimated' ? result.emotions.map(({ code, score }) => ({ code, score })).sort((a, b) => b.score - a.score || a.code.localeCompare(b.code)) : [],
            'emotionAnalysis.status': meta.status, 'emotionAnalysis.version': analysisVersion,
            'emotionAnalysis.sourceContentVersion': doc.lyrics.contentVersion, 'emotionAnalysis.analyzedAt': now(),
            'emotionAnalysis.sampled': meta.sampled === true, 'emotionAnalysis.provider': typeof meta.provider === 'string' ? meta.provider.slice(0, 40) : null,
            'emotionAnalysis.model': typeof meta.model === 'string' ? meta.model.slice(0, 200) : null,
            'emotionAnalysis.lastErrorCode': meta.status === 'unavailable' ? 'ANALYSIS_UNAVAILABLE' : null,
            'emotionAnalysis.retryAt': meta.status === 'unavailable' ? new Date(now().getTime() + config.retryMs) : null,
        }, metrics);
    }
    return async function getSongDetail(input, { analysisOnly = false, refetchLyrics = false } = {}) {
        if (analysisOnly && refetchLyrics) throw new SongError('VALIDATION_ERROR', 400);
        let doc = await resolveSong(input, Model);
        let cacheHit = true;
        let requestContent = null;
        const textFor = value => value.lyrics.status === 'available' ? value.lyrics.text : value.lyrics.status === 'transient' && permitsTransient(value)
            ? (requestContent?.version === value.lyrics.contentVersion ? requestContent.text : transient.get(value._id, value.lyrics.contentVersion)) : null;
        const needsTransientText = value => ['transient', 'rights_restricted'].includes(value.lyrics.status) && permitsTransient(value) && !textFor(value);
        // One manual acquisition per request. Followers must not re-acquire if
        // the shared lookup also ends in a miss (even with a zero test cooldown).
        let manualAttempt = refetchLyrics && manuallyRetryable(doc.lyrics.status);
        let lookupClaimAttempted = false;
        const initialAttemptCount = doc.lyrics.attemptCount;
        const deadline = Date.now() + config.waitMs;
        // Analysis-only does not refetch persisted lyrics. Transient text that
        // expired/on another process has to be obtained again to analyze it.
        while (!analysisOnly || needsTransientText(doc)) {
            const l = doc.lyrics, current = now();
            const eligible = l.status === 'never_attempted' || (l.status === 'temporary_error' && new Date(l.retryAt) <= current) ||
                (l.status === 'in_progress' && new Date(l.lease?.expiresAt || 0) <= current) ||
                (needsTransientText(doc) && !analysisBusy(doc)) ||
                (manualAttempt && l.attemptCount === initialAttemptCount && manuallyRetryable(l.status) && lyricsRefetchAt(l, config.retryMs) <= current);
            if (eligible && !lookupClaimAttempted) { lookupClaimAttempted = true; manualAttempt = false; cacheHit = false; requestContent = await acquireLyrics(doc); }
            else if ((l.status !== 'in_progress' && !(needsTransientText(doc) && analysisBusy(doc))) || Date.now() >= deadline) break;
            else { bump(metrics, 'concurrentClaimsLost'); await sleep(config.pollMs); }
            doc = await Model.findById(doc._id).maxTimeMS(2000).lean();
        }
        const analysisDeadline = Date.now() + config.waitMs;
        // Separate work stage: retries never acquire lyrics, even for legacy callers.
        while (textFor(doc)) {
            const a = doc.emotionAnalysis, current = now();
            const busy = a.status === 'in_progress';
            const validVersion = a.version === analysisVersion && a.sourceContentVersion === doc.lyrics.contentVersion;
            const eligible = busy ? new Date(a.lease?.expiresAt || 0) <= current :
                !validVersion || a.status === 'not_started' || (a.status === 'unavailable' && (analysisOnly || refetchLyrics) && new Date(a.retryAt) <= current);
            if (eligible) { cacheHit = false; await acquireAnalysis(doc, textFor(doc)); }
            else if (!busy || Date.now() >= analysisDeadline) break;
            else { bump(metrics, 'concurrentClaimsLost'); await sleep(config.pollMs); }
            doc = await Model.findById(doc._id).maxTimeMS(2000).lean();
            // One explicit retry per request, not an unbounded loop on failures.
            if (doc.emotionAnalysis.status === 'unavailable') break;
        }
        if (cacheHit) bump(metrics, 'cacheHitResponses');
        return songDetail(doc, cacheHit, { current: now(), retryMs: config.retryMs, transientText: textFor(doc), transientPermitted: permitsTransient(doc) });
    };
}
export const getCachedSongDetail = createSongCache();
