import mongoose from 'mongoose';

const options = { _id: false };
const hintSchema = new mongoose.Schema({ artist: { type: String, maxlength: 200, default: null }, genre: { type: String, maxlength: 200, default: null } }, options);
const correctionSchema = new mongoose.Schema({
    field: { type: String, enum: ['artist', 'genre'] }, original: { type: String, maxlength: 200 },
    suggested: { type: String, maxlength: 200 }, applied: Boolean, source: String,
    confidenceBand: { type: String, enum: ['high', 'uncertain'] },
}, options);
export const inputSchema = new mongoose.Schema({
    original: hintSchema, resolved: hintSchema,
    corrections: { type: [correctionSchema], validate: v => v.length <= 10 },
    needsConfirmation: Boolean, directoryStatus: { type: String, enum: ['available', 'unavailable'] },
}, options);
const songSchema = new mongoose.Schema({
    title: { type: String, maxlength: 200 }, artist: { type: String, maxlength: 200 },
    genre: { type: String, maxlength: 200 }, album: { type: String, maxlength: 200 },
    releaseYear: Number, reason: { type: String, maxlength: 2000 }, position: Number,
    catalogVerified: { type: Boolean, default: false }, modelConfidence: Number,
}, options);
const resultSchema = new mongoose.Schema({
    found: Boolean, song: { type: songSchema, default: null },
    recommendations: { type: [songSchema], validate: v => v.length <= 11 }, count: Number,
    notice: { type: String, maxlength: 500 },
    ai: new mongoose.Schema({ provider: String, model: { type: String, maxlength: 200 }, requestId: String, callCount: Number, totalElapsedMs: Number,
        recommendationGenre: { type: String, maxlength: 200 },
        attempts: { type: [new mongoose.Schema({ phase: String, provider: String, model: { type: String, maxlength: 200 }, elapsedMs: Number, status: String }, options)], validate: v => v.length <= 5 },
    }, options),
}, options);
const schema = new mongoose.Schema({
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestId: { type: String, required: true, maxlength: 36 },
    status: { type: String, enum: ['pending', 'found', 'not_found', 'error'], required: true },
    input: inputSchema, result: { type: resultSchema, default: null },
    errorCode: { type: String, enum: ['PROVIDER_ERROR', 'INTERRUPTED', null], default: null },
    expiresAt: { type: Date, required: true },
}, { timestamps: true, bufferCommands: false });
schema.index({ owner: 1, requestId: 1 }, { unique: true });
schema.index({ owner: 1, createdAt: -1, _id: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const SearchHistory = mongoose.model('SearchHistory', schema);
