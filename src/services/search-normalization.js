// Identity never uses the lossy lookup key: e.g. punctuation/accent homonyms
// can coexist and therefore remain ambiguous during folded/fuzzy resolution.
export const displayText = value => (value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
export const identityKey = value => displayText(value).toLowerCase();
export const matchKey = value => identityKey(value).normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}+#&]+/gu, ' ').trim().replace(/\s+/g, ' ');

export function grams(value) {
    const key = matchKey(value);
    return [...new Set(Array.from({ length: Math.max(0, key.length - 2) }, (_, i) => key.slice(i, i + 3)))].slice(0, 198);
}

export function editDistance(a, b) {
    const left = Array.from(a), right = Array.from(b);
    let row = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let i = 0; i < left.length; i++) {
        const next = [i + 1];
        for (let j = 0; j < right.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (left[i] === right[j] ? 0 : 1)));
        row = next;
    }
    return row[right.length];
}

export function resolveName(original, candidates, { complete = true, genre = false } = {}) {
    const value = displayText(original) || null;
    const unresolved = { value, source: null, confidenceBand: 'uncertain', candidates: [], recognized: false };
    if (!value) return unresolved;
    const key = matchKey(value), identity = identityKey(value);
    const names = [...new Map(candidates.map(c => [identityKey(c.canonicalName), c])).values()];
    const exact = names.filter(c => identityKey(c.canonicalName) === identity);
    const aliases = names.filter(c => (c.aliases || []).some(alias => identityKey(alias) === identity));
    const normalized = names.filter(c => [c.canonicalName, ...(c.aliases || [])].some(name => matchKey(name) === key));
    const matches = exact.length ? exact : aliases.length ? aliases : normalized;
    const source = genre ? 'genre_dictionary' : exact.length ? 'catalog_exact' : aliases.length ? 'catalog_alias' : 'catalog_normalized';
    if (matches.length) {
        if (matches.length === 1 && complete) return { value: matches[0].canonicalName, source, confidenceBand: 'high', candidates: [], recognized: true };
        return { ...unresolved, source, candidates: matches.map(c => c.canonicalName).slice(0, 5) };
    }
    if (key.length < 4) return unresolved;
    const ranked = names.map(c => {
        const scores = [c.canonicalName, ...(c.aliases || [])].map(name => {
            const other = matchKey(name), distance = editDistance(key, other);
            return { distance, score: 1 - distance / Math.max(Array.from(key).length, Array.from(other).length, 1) };
        }).sort((a, b) => b.score - a.score);
        return { name: c.canonicalName, ...scores[0] };
    }).filter(c => c.score >= .7).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const best = ranked[0];
    // A partial artist is not an ordinary typo. Examine ALL prefix matches,
    // including long names below the fuzzy score cutoff, before completing it.
    const prefixes = genre ? [] : names.map(c => ({
        name: c.canonicalName,
        coverage: Math.max(0, ...[c.canonicalName, ...(c.aliases || [])].map(matchKey)
            .filter(other => other.startsWith(key) && other.length > key.length).map(other => key.length / other.length)),
    })).filter(c => c.coverage > 0);
    if (prefixes.length) {
        const candidate = prefixes[0];
        const rival = ranked.find(c => c.name !== candidate.name);
        if (complete && prefixes.length === 1 && key.length >= 6 && candidate.coverage >= .75 &&
            candidate.coverage - (rival?.score || 0) >= .08) {
            return { value: candidate.name, source: 'catalog_prefix', confidenceBand: 'high', candidates: [], recognized: true };
        }
        return { ...unresolved, source: 'catalog_prefix', candidates: [...new Set([...prefixes.map(c => c.name), ...ranked.map(c => c.name)])].slice(0, 5) };
    }
    if (!best) return unresolved;
    const fuzzySource = genre ? 'genre_fuzzy' : 'catalog_fuzzy';
    if (complete && key.length >= 7 && best.distance <= (key.length >= 12 ? 2 : 1) && best.score >= .86 &&
        best.score - (ranked[1]?.score || 0) >= .08) {
        return { value: best.name, source: fuzzySource, confidenceBand: 'high', candidates: [], recognized: true };
    }
    return { ...unresolved, source: fuzzySource, candidates: ranked.slice(0, 5).map(c => c.name) };
}

// Open vocabulary: additions are data, unknown/hybrid genres stay intact.
export const GENRES = [
    ['Symphonic Metal', 'metal sinfónico', 'symphonic-metal'],
    ['Alternative Rock', 'rock alternativo', 'alt rock'], ['Industrial Rock', 'rock industrial'],
    ['Industrial Metal', 'metal industrial'], ['Heavy Metal'], ['Progressive Metal', 'prog metal'],
    ['Progressive Rock', 'prog rock'], ['Rock'], ['Metal'], ['Pop'], ['Jazz'], ['Blues'],
    ['Hip Hop', 'hip-hop', 'rap'], ['Electronic', 'electrónica'], ['Reggaeton', 'reguetón'],
    ['Punk Rock', 'punk-rock'], ['Folk'], ['Classical', 'clásica'], ['R&B', 'rhythm and blues'],
].map(([canonicalName, ...aliases]) => ({ canonicalName, aliases }));

export const resolveGenre = value => resolveName(value, GENRES, { genre: true });
