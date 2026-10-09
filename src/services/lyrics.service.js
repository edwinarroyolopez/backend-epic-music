import { songIdentityPart as identityKey } from '../models/song.model.js';
import { analyzeLyricsEmotions, emptyEmotionAnalysis } from './emotions.service.js';

const SOURCE = { name: 'LRCLIB', url: 'https://lrclib.net' };
const MAX_BYTES = 256 * 1024;
export class LyricsError extends Error {
    constructor() { super('Lyrics source unavailable'); this.code = 'LYRICS_UNAVAILABLE'; this.status = 503; }
}
async function readJson(response) {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new LyricsError();
    const reader = response.body?.getReader();
    if (!reader) throw new LyricsError();
    const decoder = new TextDecoder();
    let bytes = 0, text = '';
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_BYTES) throw new LyricsError();
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return JSON.parse(text);
    } finally { await reader.cancel().catch(() => {}); }
}

export async function lookupLyrics({ title, artist }, { fetchImpl = fetch, signal, timeoutMs = 8000 } = {}) {
    const empty = { status: 'not_found', title, artist, lyrics: null, source: SOURCE };
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
        const url = new URL('https://lrclib.net/api/get');
        url.search = new URLSearchParams({ track_name: title, artist_name: artist }).toString();
        const response = await fetchImpl(url, {
            signal: combined, redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'MusicaEpica/1.0 (lyrics lookup)' },
        });
        if (response.status === 404) return empty;
        if (!response.ok) {
            const error = new LyricsError();
            const retry = response.headers.get('retry-after');
            const delay = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
            if (Number.isFinite(delay) && delay > 0) error.retryAfterMs = Math.min(delay, 24 * 3600000);
            throw error;
        }
        const data = await readJson(response);
        if (typeof data?.trackName !== 'string' || typeof data.artistName !== 'string') throw new LyricsError();
        // Never attach a similarly named artist's lyrics to this song.
        if (identityKey(data.trackName) !== identityKey(title) || identityKey(data.artistName) !== identityKey(artist)) return empty;
        if (data.instrumental === true) return { ...empty, status: 'instrumental' };
        if (data.plainLyrics == null || data.plainLyrics === '') return empty;
        if (typeof data.plainLyrics !== 'string' || data.plainLyrics.length > 60000) throw new LyricsError();
        const lyrics = data.plainLyrics.trim();
        return lyrics ? { ...empty, status: 'available', lyrics, source: { ...SOURCE, recordId: data.id == null ? null : String(data.id).slice(0, 200) } } : empty;
    } catch (error) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        throw error instanceof LyricsError ? error : new LyricsError();
    }
}

export async function getLyricsWithEmotions(input, { signal, lookup = lookupLyrics, analyze = analyzeLyricsEmotions } = {}) {
    const data = await lookup(input, { signal });
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (data.status !== 'available') return { ...data, ...emptyEmotionAnalysis() };
    try {
        const analysis = await analyze({ title: data.title, artist: data.artist, lyrics: data.lyrics }, { signal });
        return { ...data, ...analysis };
    } catch {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        return { ...data, ...emptyEmotionAnalysis('unavailable') };
    }
}
