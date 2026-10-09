import { MusicRecommendationError, searchSimilarSongs } from "../services/music.service.js";
import { randomUUID } from 'node:crypto';
import { reserveHistory, finishHistory, serializeHistory } from '../services/search-history.service.js';

export const createSearchSongsController = (search = searchSimilarSongs) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { lyrics, artist, genre, provider, searchId } = req.body ?? {};
    if (typeof lyrics !== "string" || lyrics.trim().length < 15 || lyrics.length > 12000) {
        return res.status(400).json({ success: false, error: "lyrics debe contener entre 15 y 12000 caracteres" });
    }
    if ([artist, genre].some((value) => value !== undefined &&
        (typeof value !== "string" || value.length > 200))) {
        return res.status(400).json({ success: false, error: "artist y genre deben ser strings de hasta 200 caracteres" });
    }
    if (provider !== undefined && !["gemini", "deepseek"].includes(provider)) {
        return res.status(400).json({ success: false, error: "provider debe ser gemini o deepseek" });
    }
    if (searchId !== undefined && (typeof searchId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(searchId))) {
        return res.status(400).json({ success: false, error: 'searchId debe ser UUID v4', code: 'VALIDATION_ERROR' });
    }
    const requestId = searchId || randomUUID();
    const initialInput = { original: { artist: artist || null, genre: genre || null }, resolved: { artist: artist?.trim() || null, genre: genre?.trim() || null }, corrections: [], needsConfirmation: false, directoryStatus: req.app.locals.isReady() ? 'available' : 'unavailable' };
    let reservation = null;
    let history = { status: req.user ? 'unavailable' : 'local_only', id: null, requestId };
    if (req.historyOwner && req.app.locals.isReady()) {
        try {
            reservation = await reserveHistory(req.historyOwner, requestId, initialInput);
        } catch { /* Music remains available; persistence failure is explicit. */ }
        if (reservation && !reservation.fresh) {
            const previous = serializeHistory(reservation.doc, true);
            if (previous.status === 'pending') return res.status(409).json({ success: false, error: { code: 'SEARCH_IN_PROGRESS', message: 'Búsqueda en curso' } });
            history = { status: 'saved', id: previous.id, requestId };
            if (previous.status === 'error') return res.status(502).json({ success: false, code: previous.errorCode, error: 'La búsqueda guardada no se completó', history, input: previous.input });
            return res.json({ success: true, data: { ...previous.result, history, directory: { status: 'unchanged' } } });
        }
    }
    const persist = async (result, errorCode = null) => {
        if (reservation?.fresh) {
            try {
                await finishHistory(reservation.doc, { result: errorCode ? null : result, input: result?.input || initialInput, errorCode });
                history = { status: 'saved', id: String(reservation.doc._id), requestId };
            } catch { history = { status: 'unavailable', id: null, requestId }; }
        }
        return history;
    };
    try {
        const data = await search({ lyrics, artist, genre, provider });
        data.history = await persist(data);
        return res.status(200).json({ success: true, data });
    } catch (error) {
        console.error("Music search error:", error.name);
        return res.status(error instanceof MusicRecommendationError ? error.status : 502).json({
            success: false,
            code: 'PROVIDER_ERROR', history: await persist({ input: error.input }, 'PROVIDER_ERROR'), input: error.input || initialInput,
            error: error instanceof MusicRecommendationError
                ? error.message : "No se pudo completar la búsqueda musical con IA",
        });
    }
};

export const searchSongsController = createSearchSongsController();
