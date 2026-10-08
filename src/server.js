import 'dotenv/config';
import { createApp } from './app.js';
import { connectMongo } from './db/mongo.service.js';
import { Playlist } from './models/playlist.model.js';

await connectMongo();
await Playlist.init();
const port = Number(process.env.PORT || 7000);
const server = createApp().listen(port, () => console.log(`API Música Épica escuchando en puerto ${server.address().port}`));
