import { reidentifySong, ReidentificationError } from '../services/song-reidentification.service.js';
import { attachSongReferences } from '../services/song-identity.service.js';
import { ownedHistory, replaceHistorySong, HistoryError } from '../services/search-history.service.js';

export const createReidentifyController = ({ identify = reidentifySong, owned = ownedHistory, replace = replaceHistorySong, attach = attachSongReferences } = {}) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { lyrics, artist, previous, historyId } = req.body || {};
    if (typeof lyrics !== 'string' || lyrics.trim().length < 15 || lyrics.length > 12000 ||
        (artist !== undefined && (typeof artist !== 'string' || artist.length > 200)) ||
        (previous !== undefined && (!previous || [previous.title, previous.artist].some(v => typeof v !== 'string' || !v.trim() || v.length > 200)))) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Fragmento o pistas inválidos' } });
    }
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    try {
        let entry;
        if (historyId !== undefined) {
            if (!req.historyOwner) throw new HistoryError('UNAUTHORIZED', 401);
            if (!req.app.locals.isReady()) throw new HistoryError('UNAVAILABLE', 503);
            entry = await owned(req.historyOwner, historyId);
            if (entry.status !== 'found') throw new HistoryError('CONFLICT', 409);
        }
        const data = await identify({ lyrics: lyrics.trim(), artist, previous: previous && { title: previous.title, artist: previous.artist } }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (data.found) {
            // Never reuse the previous songId: it belongs to the wrong identity.
            if (req.app.locals.isReady()) {
                try { [data.song] = await attach([data.song]); } catch { /* Metadata remains usable. */ }
            }
            if (entry) {
                try { await replace(req.historyOwner, historyId, data.song); data.history = { status: 'saved', id: historyId }; }
                catch { data.history = { status: 'unavailable', id: historyId }; }
            }
        }
        res.json({ success: true, data });
    } catch (error) {
        if (controller.signal.aborted) return;
        const known = error instanceof HistoryError || error instanceof ReidentificationError;
        res.status(known ? error.status : 502).json({ success: false, error: { code: known ? error.code : 'PROVIDER_ERROR', message: 'No se pudo verificar la canción' } });
    } finally { res.off('close', abort); }
};
