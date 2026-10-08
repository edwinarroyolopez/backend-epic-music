import jwt from "jsonwebtoken";

export const authenticateToken = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader) {
            return res.status(401).json({
                success: false,
                error: { code: 'UNAUTHORIZED', message: 'Token requerido' },
                message: "Token requerido"
            });
        }

        const [type, token] = authHeader.split(" ");

        if (type !== "Bearer" || !token) {
            return res.status(401).json({
                success: false,
                error: { code: 'UNAUTHORIZED', message: 'Formato de token inválido' },
                message: "Formato de token inválido"
            });
        }

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        req.user = decoded;

        next();

    } catch (error) {
        if (error.name === "TokenExpiredError") {
            return res.status(401).json({
                success: false,
                error: { code: 'UNAUTHORIZED', message: 'Token expirado' },
                message: "Token expirado"
            });
        }

        return res.status(401).json({
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Token inválido' },
            message: "Token inválido"
        });
    }
};
