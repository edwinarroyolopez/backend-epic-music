export function requireDatabaseReady(req, res, next) {
    if (!req.app.locals.isReady()) {
        return res.status(503).json({
            success: false,
            error: { code: 'UNAVAILABLE', message: 'Base de datos no disponible. Inténtalo más tarde.' },
            message: 'Base de datos no disponible. Inténtalo más tarde.',
        });
    }
    next();
}
