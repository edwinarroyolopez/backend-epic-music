import express from "express";
import dotenv from "dotenv";
import cors from "cors";

import { authenticateToken } from "./middlewares/auth.middleware.js";

import aiRoutes from "./routes/ai.routes.js";
import { loginController, signupController } from './controllers/user.controller.js';
import mongoose from "mongoose";
import { findUserById } from "./services/user.service.js";
import { createSearchSongsController } from "./controllers/music.controller.js";
import { playlistRoutes } from './routes/playlist.routes.js';

dotenv.config();

const allowedOrigins = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://TU-SITIO.netlify.app"
];

export function createApp({ search } = {}) {
const app = express();


app.use(
    cors({
        origin: (origin, callback) => {

            // Permite requests sin Origin:
            // Postman, Thunder Client, servidor a servidor, etc.
            if (!origin) {
                return callback(null, true);
            }

            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }

            return callback(
                new Error(`Origin no permitido por CORS: ${origin}`)
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
    res.status(connected ? 200 : 503).json({ success: connected, data: { database: connected ? 'connected' : 'disconnected' } });
});
app.get('/auth/providers', (_req, res) => res.json({ email: true, apple: false, google: false, spotify: false }));

app.get('/', (request, response) => {
    response.send("<h2>Esta es la API de Música Épica</h2>")
})


app.post(
    "/auth/login",
    loginController
);

app.post(
    "/auth/signup",
    signupController
);

app.get(
    "/auth/me",
    authenticateToken,
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
    const status = error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    res.status(status).json({ success: false, error: { code: status === 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR', message: status === 500 ? 'Error interno' : 'JSON inválido o demasiado grande' } });
});
return app;
}
