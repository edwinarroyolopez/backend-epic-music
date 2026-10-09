// These are search links, not verified catalog identifiers.
export function songLinks({ title, artist }) {
    const query = `${title.trim()} ${artist.trim()}`;
    return {
        youtube: `https://www.youtube.com/results?${new URLSearchParams({ search_query: query })}`,
        spotify: `https://open.spotify.com/search/${encodeURIComponent(query)}`,
        appleMusic: `https://music.apple.com/us/search?${new URLSearchParams({ term: query })}`,
    };
}

export function withSongLinks(result) {
    if (!result?.found) return result;
    const decorate = song => ({ ...song, links: songLinks(song) });
    return { ...result, song: decorate(result.song), recommendations: result.recommendations.map(decorate) };
}
