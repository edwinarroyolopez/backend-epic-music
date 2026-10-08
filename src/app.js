import express from "express";
import dotenv from "dotenv";
import cors from "cors";

import { authenticateToken } from "./middlewares/auth.middleware.js";
import { requireDatabaseReady } from './middlewares/database.middleware.js';

import aiRoutes from "./routes/ai.routes.js";
import { loginController, signupController } from './controllers/user.controller.js';
import mongoose from "mongoose";
import { findUserById } from "./services/user.service.js";
import { createSearchSongsController } from "./controllers/music.controller.js";
import { playlistRoutes } from './routes/playlist.routes.js';

dotenv.config();

const allowedOrigins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://musica-epica-ed.netlify.app"
];
// Deploy permalinks, deploy-preview-N and branch deploys of this site only.
const netlifyPreviewOrigin = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?--musica-epica-ed\.netlify\.app$/;

export function createApp({ search, isReady = () => mongoose.connection.readyState === 1 } = {}) {
const app = express();
app.locals.isReady = isReady;
const origins = new Set([...allowedOrigins, ...(process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)]);


app.use(
    cors({
        origin: (origin, callback) => {

            // Permite requests sin Origin:
            // Postman, Thunder Client, servidor a servidor, etc.
            if (!origin) {
                return callback(null, true);
            }

            if (origins.has(origin) || netlifyPreviewOrigin.test(origin)) {
                return callback(null, true);
            }

            return callback(
                Object.assign(new Error('Origen no permitido por CORS'), { code: 'CORS_ORIGIN_DENIED' })
            );
        },

        methods: [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS"
        ],

        allowedHeaders: [
            "Content-Type",
            "Authorization"
        ],

        credentials: true
    })
);


app.use(express.json({ limit: '512kb' }));

app.get('/health', (_req, res) => {
    const connected = mongoose.connection.readyState === 1;
    const ready = connected && isReady();
    res.status(ready ? 200 : 503).json({
        success: ready,
        data: { database: connected ? 'connected' : 'disconnected', ready },
        ...(!ready && { error: { code: 'UNAVAILABLE', message: 'Base de datos o índices no disponibles' } }),
    });
});
app.get('/auth/providers', (_req, res) => res.json({ email: true, apple: false, google: false, spotify: false }));

app.get('/', (request, response) => {
    response.send("<h2>Esta es la API de Música Épica</h2>")
})


app.post(
    "/auth/login",
    requireDatabaseReady,
    loginController
);

app.post(
    "/auth/signup",
    requireDatabaseReady,
    signupController
);

app.get(
    "/auth/me",
    authenticateToken,
    requireDatabaseReady,
    async (req, res) => {

        try {

            const user =
                await findUserById(
                    req.user.sub
                );


            if (!user) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Usuario no encontrado"
                    });

            }

            if (!user.active) return res.status(403).json({ success: false, message: 'Cuenta desactivada' });


            return res.json({

                success: true,

                user: {
                    id: user._id,
                    username:
                        user.username,
                    name:
                        user.name,
                    email:
                        user.email,
                    phone:
                        user.phone,
                    active:
                        user.active,
                    createdAt:
                        user.createdAt
                }

            });


        } catch (error) {

            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Error obteniendo la sesión"
                });

        }

    }
);

app.use("/ai", aiRoutes);
app.use('/playlists', playlistRoutes);

/* music things */
app.post('/search-songs', createSearchSongsController(search));
app.use((error, _req, res, _next) => {
    if (error.code === 'CORS_ORIGIN_DENIED') {
        return res.status(403).json({ success: false, error: { code: error.code, message: 'Origen no permitido por CORS' } });
    }
    const status = error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    res.status(status).json({ success: false, error: { code: status === 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR', message: status === 500 ? 'Error interno' : 'JSON inválido o demasiado grande' } });
});
return app;
}
