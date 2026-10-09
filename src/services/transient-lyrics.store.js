// Short-lived process memory, never Mongo, disk, logs or browser storage.
// Mongo remains responsible for claims and content-version fencing.
export function createTransientLyricsStore({ ttlMs = 300000, maxEntries = 100, now = () => new Date() } = {}) {
    const entries = new Map();
    const remove = key => { clearTimeout(entries.get(key)?.timer); entries.delete(key); };
    return {
        get(id, version) {
            const key = String(id), entry = entries.get(key);
            if (!entry) return null;
            if (+now() >= entry.expiresAt) { remove(key); return null; }
            return entry.version === version ? entry.text : null;
        },
        put(id, version, text) {
            const key = String(id);
            remove(key);
            const timer = setTimeout(() => remove(key), ttlMs);
            timer.unref?.();
            entries.set(key, { version, text, expiresAt: +now() + ttlMs, timer });
            while (entries.size > maxEntries) remove(entries.keys().next().value);
        },
        delete: id => remove(String(id)),
        clear() { for (const key of entries.keys()) remove(key); },
    };
}
