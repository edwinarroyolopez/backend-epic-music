import { Router } from 'express';
import { getLyricsWithEmotions } from '../services/lyrics.service.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';

export function createLyricsRoutes(lookup = getLyricsWithEmotions) {
    const router = Router();
    router.get('/lyrics', rateLimit({ limit: 30 }), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const { title, artist } = req.query;
        if ([title, artist].some(value => typeof value !== 'string' || !value.trim() || value.length > 200)) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'title y artist: 1–200 caracteres' } });
        }
        const controller = new AbortController();
        const close = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', close);
        try {
            const data = await lookup({ title: title.trim(), artist: artist.trim() }, { signal: controller.signal });
            if (!controller.signal.aborted) res.json({ success: true, data });
        } catch {
            if (!controller.signal.aborted) res.status(503).json({ success: false, error: { code: 'LYRICS_UNAVAILABLE', message: 'Fuente de letras no disponible' } });
        } finally { res.off('close', close); }
    });
    return router;
}
