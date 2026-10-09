import { Router } from 'express';
import { requireDatabaseReady } from '../middlewares/database.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { suggestArtists } from '../services/artist.service.js';

export function createArtistRoutes() {
    const router = Router();
    router.use('/suggest', (_req, res, next) => { res.set('Cache-Control', 'no-cache'); next(); });
    router.get('/suggest', rateLimit(), async (req, res, next) => {
        const { q, limit = '6' } = req.query;
        if (typeof q !== 'string' || q.length > 200 || q.trim().length < 2 || typeof limit !== 'string' || !/^\d{1,2}$/.test(limit) || +limit < 1 || +limit > 10) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'q: 2–200 caracteres; limit: 1–10' } });
        }
        next();
    }, requireDatabaseReady, async (req, res) => {
        try { res.json({ success: true, data: await suggestArtists(req.query.q.trim(), +(req.query.limit || 6)) }); }
        catch { res.status(503).json({ success: false, error: { code: 'UNAVAILABLE', message: 'Directorio no disponible' } }); }
    });
    return router;
}
