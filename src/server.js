import 'dotenv/config';
import { createApp } from './app.js';
import { connectMongo } from './db/mongo.service.js';
import { Playlist } from './models/playlist.model.js';
import { Artist } from './models/artist.model.js';
import { SearchHistory } from './models/search-history.model.js';
import mongoose from 'mongoose';

const port = Number(process.env.PORT || 7000);
// This app originally used port 7000; existing domains may still target it.
// Preserve that port while also serving Railway's assigned PORT/healthcheck.
// Both listeners share one Express app and one database initialization.
const legacyPort = process.env.RAILWAY_ENVIRONMENT_ID
    ? Number(process.env.LEGACY_HTTP_PORT ?? 7000) : 0;
let databaseInitialized = false;
const app = createApp({ isReady: () => databaseInitialized && mongoose.connection.readyState === 1 });

// CORS and public provider discovery must respond even while Mongo is starting.
// Railway must use /health (readiness), not merely an open TCP port.
function listen(httpPort, label) {
    return new Promise((resolve, reject) => {
        const server = app.listen(httpPort, '0.0.0.0', () => {
            console.log(`${label} ${server.address().port}`);
            resolve(server);
        });
        server.once('error', reject);
    });
}

const server = await listen(port, 'API Música Épica escuchando en puerto');
if (legacyPort > 0 && legacyPort !== server.address().port) {
    await listen(legacyPort, 'Puerto HTTP compatible con dominio existente:');
}

try {
    await connectMongo();
    await Promise.all([Playlist.init(), Artist.init(), SearchHistory.init()]);
    databaseInitialized = true;
    console.log('API lista: MongoDB e índices inicializados');
} catch (error) {
    // Keep diagnostic HTTP/OPTIONS available; never claim a healthy database.
    // Do not log error.message: driver errors may contain a connection URI.
    console.error(`API no disponible: inicialización MongoDB/índices fallida (${error.name}). Revisar MONGODB_URI, conectividad y permisos.`);
}
