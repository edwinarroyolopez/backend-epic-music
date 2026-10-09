import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware.js';
import { requireDatabaseReady } from '../middlewares/database.middleware.js';
import { requireActiveSearchUser } from '../middlewares/search-auth.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { previewSelection } from '../services/playlist-personality-domain.service.js';
import { createPersonalityService, ownedAnalysis, serializeAnalysis } from '../services/playlist-personality.service.js';
import { PlaylistAnalysis } from '../models/playlist-analysis.model.js';
import { fail } from '../services/playlist-personality-domain.service.js';
import { createPlaylistPreview } from '../services/youtube-playlist-adapter.service.js';

export function createPlaylistPersonalityRoutes(options) {
    const router = Router();
    const analyze = createPersonalityService(options);
    const preview = createPlaylistPreview(options?.youtube);
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.use(rateLimit({ limit: 60 }));
    router.get('/providers', (_req, res) => res.json({ success: true, data: preview.capabilities() }));
    router.use((req, res, next) => {
        if (!req.headers.authorization) return next();
        authenticateToken(req, res, () => requireDatabaseReady(req, res, () => requireActiveSearchUser(req, res, next)));
    });
    router.post('/preview', async (req, res) => {
        const controller = new AbortController();
        const close = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', close);
        try {
            const data = req.body?.sourceMode === 'link' ? await preview.retrieve(req.body, { signal: controller.signal, scope: String(req.historyOwner || req.ip) }) : await previewSelection(req.body, req.historyOwner);
            if (data.retryAfter) res.set('Retry-After', String(data.retryAfter));
            if (!controller.signal.aborted) res.json({ success: true, data });
        } finally { res.off('close', close); }
    });
    router.post('/analyze', rateLimit({ limit: 10 }), rateLimit({ limit: 10, keyFor: req => req.historyOwner || req.socket.remoteAddress || 'guest' }), async (req, res) => res.json({ success: true, data: await analyze(req.body, req.historyOwner, req.ip) }));
    router.use('/history', (req, _res, next) => { if (!req.historyOwner) fail('UNAUTHORIZED', 401); next(); });
    router.get('/history', async (req, res) => {
        if (req.query.cursor && (typeof req.query.cursor !== 'string' || !/^[a-f\d]{24}$/i.test(req.query.cursor))) fail();
        const docs = await PlaylistAnalysis.find({ owner: req.historyOwner, expiresAt: { $gt: new Date() }, ...(req.query.cursor && { _id: { $lt: req.query.cursor } }) })
            .select('-songs -report -requestIds').sort({ _id: -1 }).limit(21).maxTimeMS(2000).lean();
        res.json({ success: true, data: { entries: docs.slice(0, 20).map(d => serializeAnalysis(d, false)), nextCursor: docs.length > 20 ? String(docs[19]._id) : null } });
    });
    router.get('/history/:id', async (req, res) => res.json({ success: true, data: { entry: serializeAnalysis(await ownedAnalysis(req.historyOwner, req.params.id)) } }));
    router.delete('/history/:id', async (req, res) => {
        const doc = await ownedAnalysis(req.historyOwner, req.params.id);
        if (doc.status === 'pending' && doc.leaseUntil > new Date()) fail('ANALYSIS_IN_PROGRESS', 409);
        const result = await PlaylistAnalysis.deleteOne({ _id: doc._id, owner: req.historyOwner, $or: [{ status: { $ne: 'pending' } }, { leaseUntil: { $lte: new Date() } }] }).maxTimeMS(2000);
        if (!result.deletedCount) fail('ANALYSIS_IN_PROGRESS', 409);
        res.json({ success: true, data: { deleted: true } });
    });
    router.use((error, _req, res, _next) => {
        if (error.code === 'ANALYSIS_IN_PROGRESS') res.set('Retry-After', '3');
        res.status(error.status || 503).json({ success: false, error: { code: error.status ? error.code : 'UNAVAILABLE', message: error.status ? error.code : 'UNAVAILABLE' } });
    });
    return router;
}
