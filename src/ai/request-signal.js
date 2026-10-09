// Existing searches keep their 45s bound; auxiliary analysis can use a shorter
// budget and cancellation follows the client through the provider HTTP request.
export function aiRequestSignal(signal, timeoutMs = 45000) {
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(1, Math.min(45000, Math.floor(timeoutMs))) : 45000;
    const timeout = AbortSignal.timeout(budget);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
