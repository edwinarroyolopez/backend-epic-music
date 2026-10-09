import { authenticateToken } from './auth.middleware.js';
import { User } from '../models/user.model.js';

const reject = (res, status, code) => res.status(status).json({ success: false, error: { code, message: code } });
export async function requireActiveSearchUser(req, res, next) {
    if (typeof req.user?.sub !== 'string' || !/^[a-f\d]{24}$/i.test(req.user.sub)) return reject(res, 401, 'UNAUTHORIZED');
    try {
        const user = await User.findById(req.user.sub).select('active').maxTimeMS(1000).lean();
        if (!user) return reject(res, 401, 'UNAUTHORIZED');
        if (!user.active) return reject(res, 403, 'ACCOUNT_DISABLED');
        req.historyOwner = String(user._id);
        next();
    } catch { return reject(res, 503, 'UNAVAILABLE'); }
}

export function optionalSearchAuth(req, res, next) {
    if (!req.headers.authorization) return next();
    authenticateToken(req, res, () => {
        if (typeof req.user?.sub !== 'string' || !/^[a-f\d]{24}$/i.test(req.user.sub)) return reject(res, 401, 'UNAUTHORIZED');
        // Signature is valid but account cannot be checked. Search stays public;
        // no ownership/persistence is inferred from an unverified account.
        if (!req.app.locals.isReady()) return next();
        return requireActiveSearchUser(req, res, next);
    });
}
