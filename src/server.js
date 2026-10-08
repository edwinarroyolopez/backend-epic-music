import express from "express";
import dotenv from "dotenv";
import cors from "cors";

import { authenticateToken } from "./middlewares/auth.middleware.js";

import aiRoutes from "./routes/ai.routes.js";
import { loginController, signupController } from './controllers/user.controller.js';
import { connectMongo } from "./db/mongo.service.js";
import { findUserById } from "./services/user.service.js";
import { searchSongsController } from "./controllers/music.controller.js";

dotenv.config();

const allowedOrigins = [
    "http://localhost:3000",
    "https://TU-SITIO.netlify.app"
];

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


app.use(express.json());

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

/* music things */
app.post('/search-songs', searchSongsController)

const startServer = async () => {

    await connectMongo();

    app.listen(7000, () => {
        console.log("Server is running on http://localhost:7000")
    })
}

startServer();


console.log("This is the server!");

