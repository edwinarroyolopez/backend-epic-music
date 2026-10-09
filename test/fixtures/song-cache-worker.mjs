// IPC worker for distributed tests; Mongo URI always points at the parent's ephemeral mongod.
import mongoose from 'mongoose';
import { createSongCache } from '../../src/services/song-cache.service.js';
import { analyzeLyricsEmotions } from '../../src/services/emotions.service.js';
const metrics = { externalLyricsCalls: 0, emotionAICalls: 0 };
await mongoose.connect(process.argv[2]);
const cache = createSongCache({ metrics, waitMs: 3000,
    storagePolicy: () => ({ authorized: true, reference: 'Own IPC test fixture' }),
    lookup: async song => { metrics.externalLyricsCalls++; await new Promise(r => setTimeout(r, 100)); return { ...song, status: 'available', lyrics: 'Own synthetic distributed text', source: { name: 'OWN_FIXTURE' } }; },
    analyze: (song, options) => analyzeLyricsEmotions(song, { ...options, callAI: async () => {
        metrics.emotionAICalls++; await new Promise(r => setTimeout(r, 100));
        return { provider: 'fixture', model: 'ipc', content: JSON.stringify({ sufficientEvidence: true, emotions: [{ code: 'joy', score: 50 }, { code: 'hope', score: 30 }, { code: 'love', score: 20 }] }) };
    } }),
});
process.send({ ready: true });
process.once('message', async ({ input }) => {
    try {
        const data = await Promise.all(Array.from({ length: 10 }, () => cache(input)));
        process.send({ metrics, ids: data.map(d => d.songId), statuses: data.map(d => d.emotionAnalysis.status) });
        await mongoose.disconnect(); process.disconnect();
    } catch { process.send({ error: 'WORKER_FAILED' }); await mongoose.disconnect(); process.exitCode = 1; process.disconnect(); }
});
