import { fail } from './playlist-personality-domain.service.js';

export function getProviderCapabilities({ apiKey = process.env.YOUTUBE_API_KEY, enabled = process.env.YOUTUBE_PREVIEW_ENABLED === 'true' } = {}) {
    return {
        manual: { status: 'available', analysis: true, analysis_access: 'eligible' },
        internal: { status: 'available', analysis: true, analysis_access: 'eligible', requiresAccount: true },
        spotify: { status: 'configuration_required', metadata_access: 'not_configured', analysis_access: 'restricted_policy', import: false, analysis: false, messageCode: 'SPOTIFY_INTEGRATION_PENDING', reference: 'https://developer.spotify.com/policy' },
        youtube: { status: enabled && apiKey ? 'link_recognized' : 'configuration_required', metadata_access: enabled && apiKey ? 'available' : 'not_configured', analysis_access: 'requires_written_permission', import: false, analysis: false, messageCode: enabled && apiKey ? 'YOUTUBE_READY_TO_PREVIEW' : 'YOUTUBE_CONFIGURATION_REQUIRED', reference: 'https://developers.google.com/youtube/terms/developer-policies' },
    };
}
export const providerCapabilities = getProviderCapabilities();

// Recognition only: no transport, redirects, tokens, content access or persistence.
export function recognizePlaylistURL(value, capabilities = getProviderCapabilities()) {
    if (typeof value !== 'string' || value.length > 500 || /[\s\p{Cc}\\]/u.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) fail();
    let url;
    try { url = new URL(value); } catch { fail(); }
    // Reject explicit ports even when WHATWG normalizes :443 away, encoded hosts and dot segments.
    if (!/^https:\/\/[a-z.]+\//.test(value) || /\/\.{1,2}(?:\/|\?|$)|%2e/i.test(value) || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) fail();
    const result = (provider, resourceType, canonicalUrl, extra = {}) => ({ ...capabilities[provider], url_recognized: true, provider, resourceType, originalUrl: value, canonicalUrl,
        sourceProvenance: 'link_only', availableActions: ['open_provider', 'use_independent_selection'], ...extra });
    if (url.hostname === 'open.spotify.com') {
        const match = url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?playlist\/([a-zA-Z0-9]{22})\/?$/);
        if (!match) fail();
        return result('spotify', 'spotify_playlist', `https://open.spotify.com/playlist/${match[1]}`, { id: match[1], playlistId: match[1] });
    }
    if (!['www.youtube.com', 'youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)) fail();
    for (const key of ['list', 'v', 'start_radio']) if (url.searchParams.getAll(key).length > 1) fail();
    const short = url.hostname === 'youtu.be';
    if (!short && !['/playlist', '/watch'].includes(url.pathname)) fail();
    const id = url.searchParams.get('list');
    const video = short ? url.pathname.slice(1) : url.searchParams.get('v');
    if (id !== null && !/^[a-zA-Z0-9_-]{10,100}$/.test(id)) fail();
    if (video !== null && !/^[a-zA-Z0-9_-]{11}$/.test(video)) fail();
    if (!id && !video || url.pathname === '/playlist' && !id || short && !video) fail();
    if (id?.startsWith('RD') || url.searchParams.get('start_radio') === '1') {
        return result('youtube', 'youtube_radio', value, { ...(id && { id, playlistId: id }), status: 'dynamic_radio', metadata_access: 'not_supported', messageCode: 'YOUTUBE_DYNAMIC_RADIO', availableActions: ['open_provider', 'use_fixed_playlist', 'use_independent_selection'] });
    }
    if (!id) return result('youtube', 'youtube_video', `https://www.youtube.com/watch?v=${video}`, { status: 'unsupported', metadata_access: 'not_supported', messageCode: 'YOUTUBE_VIDEO_ONLY' });
    return result('youtube', 'youtube_playlist', `https://www.youtube.com/playlist?list=${id}`, { id, playlistId: id, availableActions: [...(capabilities.youtube.metadata_access === 'available' ? ['retrieve_preview'] : []), 'open_provider', 'use_independent_selection'] });
}
