import { MusicRecommendationError, searchSimilarSongs } from "../services/music.service.js";

export const searchSongsController = async (req, res) => {
    const { lyrics, artist, genre, provider } = req.body ?? {};
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
    try {
        const data = await searchSimilarSongs({ lyrics, artist, genre, provider });
        return res.status(200).json({ success: true, data });
    } catch (error) {
        console.error("Music search error:", error.name);
        return res.status(error instanceof MusicRecommendationError ? error.status : 502).json({
            success: false,
            error: error instanceof MusicRecommendationError
                ? error.message : "No se pudo completar la búsqueda musical con IA",
        });
    }
};
