import { Router } from 'express';
import { getCachedSongDetail } from '../services/song-cache.service.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';

export function createLyricsRoutes(lookup = getCachedSongDetail) {
    const router = Router();
    router.get('/lyrics', rateLimit({ limit: 120 }), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const { title, artist, songId, edition, analysisOnly, refetchLyrics } = req.query;
        if ((!songId && [title, artist].some(value => typeof value !== 'string' || !value.trim() || value.length > 200)) ||
            ([title, artist].some(value => value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 200))) ||
            ((title === undefined) !== (artist === undefined)) ||
            (songId !== undefined && (typeof songId !== 'string' || !/^[a-f\d]{24}$/i.test(songId))) ||
            (edition !== undefined && (typeof edition !== 'string' || edition.length > 200)) ||
            [analysisOnly, refetchLyrics].some(value => value !== undefined && !['true', 'false'].includes(value)) ||
            (analysisOnly === 'true' && refetchLyrics === 'true')) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'title y artist: 1–200 caracteres' } });
        }
        const controller = new AbortController();
        const close = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', close);
        try {
            if (lookup === getCachedSongDetail && !req.app.locals.isReady()) {
                return res.status(503).json({ success: false, error: { code: 'SONG_CACHE_UNAVAILABLE', message: 'Base de datos o índices no disponibles' } });
            }
            const data = await lookup({ ...(songId && { songId }), ...(title && { title: title.trim(), artist: artist.trim() }), ...(edition && { edition }) },
                { signal: controller.signal, analysisOnly: analysisOnly === 'true', refetchLyrics: refetchLyrics === 'true' });
            if (data.retryAfter) res.set('Retry-After', String(data.retryAfter));
            if (!controller.signal.aborted) res.status(data.status === 'in_progress' || data.emotionAnalysis?.status === 'in_progress' ? 202 : 200).json({ success: true, data });
        } catch (error) {
            const safe = ['SONG_CACHE_UNAVAILABLE', 'SONG_NOT_FOUND', 'VALIDATION_ERROR', 'SONG_IDENTITY_MISMATCH'].includes(error.code);
            if (!controller.signal.aborted) res.status(safe ? error.status : 503).json({ success: false, error: { code: safe ? error.code : 'LYRICS_UNAVAILABLE', message: 'Detalle de canción no disponible' } });
        } finally { res.off('close', close); }
    });
    return router;
}
