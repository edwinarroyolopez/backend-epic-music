import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware.js';
import { requireDatabaseReady } from '../middlewares/database.middleware.js';
import { requireActiveSearchUser } from '../middlewares/search-auth.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { SearchHistory } from '../models/search-history.model.js';
import { HistoryError, listHistory, ownedHistory, serializeHistory } from '../services/search-history.service.js';

export function createSearchHistoryRoutes() {
    const router = Router();
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.use(rateLimit({ limit: 120 }), authenticateToken, requireDatabaseReady, requireActiveSearchUser);
    router.get('/', async (req, res) => res.json({ success: true, data: await listHistory(req.historyOwner, req.query) }));
    router.get('/:id', async (req, res) => res.json({ success: true, data: { entry: serializeHistory(await ownedHistory(req.historyOwner, req.params.id), true) } }));
    router.delete('/:id', async (req, res) => {
        const doc = await ownedHistory(req.historyOwner, req.params.id);
        if (doc.status === 'pending' && serializeHistory(doc).status === 'pending') throw new HistoryError('SEARCH_IN_PROGRESS', 409);
        await SearchHistory.deleteOne({ _id: doc._id, owner: req.historyOwner }).maxTimeMS(1000);
        res.json({ success: true, data: { deleted: true } });
    });
    router.use((error, _req, res, _next) => {
        const known = error instanceof HistoryError;
        res.status(known ? error.status : 503).json({ success: false, error: { code: known ? error.code : 'UNAVAILABLE', message: known ? error.message : 'Historial no disponible' } });
    });
    return router;
}
