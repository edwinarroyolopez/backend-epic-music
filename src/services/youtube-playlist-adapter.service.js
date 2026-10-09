import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fail } from './playlist-personality-domain.service.js';
import { recognizePlaylistURL, getProviderCapabilities } from './playlist-provider-gate.service.js';
import { rememberProviderRows } from './playlist-provenance.service.js';

const MAX_BYTES = 512 * 1024;
async function boundedJSON(response) {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('RESPONSE_TOO_LARGE'); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('INVALID_RESPONSE');
    const chunks = []; let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) throw new Error('RESPONSE_TOO_LARGE');
            chunks.push(Buffer.from(value));
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { await reader.cancel().catch(() => {}); }
}
export function createPlaylistPreview({ apiKey = process.env.YOUTUBE_API_KEY, enabled = process.env.YOUTUBE_PREVIEW_ENABLED === 'true', fetchImpl = globalThis.fetch, timeoutMs = 8000, hourlyBudget = 100 } = {}) {
    const secret = randomBytes(32);
    let used = 0, resetAt = Date.now() + 3600000, cooldownUntil = 0;
    const capabilities = () => getProviderCapabilities({ apiKey, enabled });
    const mac = text => createHmac('sha256', secret).update(text).digest();
    function encode(data) { const text = Buffer.from(JSON.stringify(data)).toString('base64url'); return `${text}.${mac(text).toString('base64url')}`; }
    function decode(token, id, scope) {
        if (typeof token !== 'string' || token.length > 3000) fail('INVALID_PAGE_TOKEN', 400);
        try {
            const [text, signature, extra] = token.split('.'), supplied = Buffer.from(signature || '', 'base64url');
            if (extra || supplied.length !== 32 || !timingSafeEqual(mac(text), supplied)) throw new Error();
            const value = JSON.parse(Buffer.from(text, 'base64url'));
            if (value.id !== id || value.scope !== scope || value.expires < Date.now() || !Number.isInteger(value.page) || value.page < 1 || value.page > 9 || typeof value.token !== 'string') throw new Error();
            return value;
        } catch { fail('INVALID_PAGE_TOKEN', 400); }
    }
    async function request(resource, params, signal) {
        if (Date.now() >= resetAt) { used = 0; resetAt = Date.now() + 3600000; }
        if (Date.now() < cooldownUntil || used >= hourlyBudget) throw { status: 'rate_limited', retryAfter: Math.max(1, Math.ceil(((used >= hourlyBudget ? resetAt : cooldownUntil) - Date.now()) / 1000)) };
        signal.throwIfAborted(); used++;
        const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        const response = await fetchImpl(url, { redirect: 'error', signal, headers: { 'X-Goog-Api-Key': apiKey, Accept: 'application/json' } });
        const data = await boundedJSON(response);
        if (!response.ok) {
            const reason = data?.error?.errors?.[0]?.reason;
            const quota = ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded'].includes(reason);
            const status = quota || response.status === 429 ? 'rate_limited' : ({ 401: 'auth_required', 403: 'permission_denied', 404: 'not_found', 400: 'unsupported' }[response.status] || 'provider_error');
            if (status === 'rate_limited') {
                const header = response.headers.get('retry-after');
                const seconds = /^\d+$/.test(header || '') ? Number(header) : Math.ceil((Date.parse(header) - Date.now()) / 1000);
                const retryAfter = Math.min(86400, Math.max(1, seconds || (quota ? 3600 : 60)));
                cooldownUntil = Date.now() + retryAfter * 1000;
                throw { status, retryAfter };
            }
            throw { status };
        }
        if (!Array.isArray(data.items)) throw new Error('INVALID_RESPONSE');
        return data;
    }
    const retrieve = async (body, { signal, scope = 'guest' } = {}) => {
        const link = recognizePlaylistURL(body?.url, capabilities());
        if (link.resourceType !== 'youtube_playlist' || link.metadata_access !== 'available') return link;
        const cursor = body.nextPageToken === undefined ? null : decode(body.nextPageToken, link.playlistId, scope);
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        try {
            let title;
            if (!cursor) {
                const metadata = await request('playlists', { part: 'snippet', id: link.playlistId, fields: 'items(snippet(title))' }, combined);
                if (!metadata.items.length) throw { status: 'not_found' };
                title = metadata.items[0]?.snippet?.title;
                if (typeof title !== 'string') throw new Error('INVALID_RESPONSE');
            }
            const data = await request('playlistItems', { part: 'snippet,contentDetails', playlistId: link.playlistId, maxResults: '50', fields: 'nextPageToken,pageInfo(totalResults),items(snippet(title,videoOwnerChannelTitle),contentDetails(videoId))', ...(cursor && { pageToken: cursor.token }) }, combined);
            if (data.items.length > 50 || !Number.isInteger(data.pageInfo?.totalResults) || data.pageInfo.totalResults < 0) throw new Error('INVALID_RESPONSE');
            const items = data.items.map(item => {
                const videoId = item.contentDetails?.videoId;
                if (typeof item.snippet?.title !== 'string') throw new Error('INVALID_RESPONSE');
                const available = /^[\w-]{11}$/.test(videoId || '') && !['Private video', 'Deleted video'].includes(item.snippet.title);
                return { title: item.snippet.title, channelTitle: item.snippet.videoOwnerChannelTitle || '', ...(available && { videoId, url: `https://www.youtube.com/watch?v=${videoId}` }), availability: available ? 'available' : 'unavailable', provenance: 'provider_api_metadata' };
            });
            rememberProviderRows(items);
            const page = cursor?.page || 0;
            if (data.nextPageToken !== undefined && (typeof data.nextPageToken !== 'string' || data.nextPageToken.length > 1024)) throw new Error('INVALID_RESPONSE');
            return { ...link, status: 'preview_ready', messageCode: items.length ? 'YOUTUBE_PREVIEW_READY' : 'YOUTUBE_EMPTY_PLAYLIST', sourceProvenance: 'provider_api_metadata', preview: { ...(title !== undefined && { title }), items, attribution: 'YouTube' }, totalItems: data.pageInfo.totalResults,
                nextPageToken: data.nextPageToken && page < 9 ? encode({ id: link.playlistId, scope, token: data.nextPageToken, page: page + 1, expires: Date.now() + 15 * 60000 }) : null,
                truncated: Boolean(data.nextPageToken && page >= 9), availableActions: ['open_provider', 'use_independent_selection', ...(data.nextPageToken && page < 9 ? ['load_more'] : [])] };
        } catch (error) {
            if (signal?.aborted) throw signal.reason;
            const status = error.status || 'provider_error';
            return { ...link, status, metadata_access: status === 'permission_denied' ? 'forbidden' : 'unavailable', messageCode: controller.signal.aborted ? 'YOUTUBE_TIMEOUT' : `YOUTUBE_${status.toUpperCase()}`, ...(error.retryAfter && { retryAfter: error.retryAfter }) };
        } finally { clearTimeout(timer); }
    };
    return { retrieve, capabilities };
}
