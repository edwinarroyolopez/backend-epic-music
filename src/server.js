import 'dotenv/config';
import { createApp } from './app.js';
import { connectMongo } from './db/mongo.service.js';
import { Playlist } from './models/playlist.model.js';
import mongoose from 'mongoose';

const port = Number(process.env.PORT || 7000);
let databaseInitialized = false;
const app = createApp({ isReady: () => databaseInitialized && mongoose.connection.readyState === 1 });

// CORS and public provider discovery must respond even while Mongo is starting.
// Railway must use /health (readiness), not merely an open TCP port.
const server = app.listen(port, '0.0.0.0', async () => {
    console.log(`API Música Épica escuchando en puerto ${server.address().port}`);
    try {
        await connectMongo();
        await Playlist.init();
        databaseInitialized = true;
        console.log('API lista: MongoDB e índices inicializados');
    } catch (error) {
        // Keep diagnostic HTTP/OPTIONS available; never claim a healthy database.
        // Do not log error.message: driver errors may contain a connection URI.
        console.error(`API no disponible: inicialización MongoDB/índices fallida (${error.name}). Revisar MONGODB_URI, conectividad y permisos.`);
    }
});
