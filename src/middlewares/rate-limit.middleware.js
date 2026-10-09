// Single-process, bounded-memory limiter. Deliberately ignores spoofable headers.
export function rateLimit({ limit = 60, windowMs = 60000, maxKeys = 5000 } = {}) {
    const buckets = new Map();
    return (req, res, next) => {
        const now = Date.now(), key = req.socket.remoteAddress || 'unknown';
        if (buckets.size >= maxKeys) for (const [id, value] of buckets) if (value.until <= now) buckets.delete(id);
        let bucket = buckets.get(key);
        if (!bucket || bucket.until <= now) {
            if (!bucket && buckets.size >= maxKeys) return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Demasiadas solicitudes' } });
            bucket = { count: 0, until: now + windowMs };
            buckets.set(key, bucket);
        }
        if (++bucket.count > limit) return res.set('Retry-After', String(Math.ceil((bucket.until - now) / 1000))).status(429)
            .json({ success: false, error: { code: 'RATE_LIMITED', message: 'Demasiadas solicitudes' } });
        next();
    };
}
