import mongoose from 'mongoose';
const songSchema = new mongoose.Schema({
    title: { type: String, required: true, maxlength: 200 }, artist: { type: String, required: true, maxlength: 200 },
    edition: { type: String, maxlength: 200 }, genre: { type: String, maxlength: 200 }, index: Number,
    songId: { type: String, match: /^[a-f\d]{24}$/i }, duplicate: Boolean, catalogVerified: { type: Boolean, default: false },
    provenance: { type: String, enum: ['user_independent', 'internal_selection'] },
}, { _id: false, strict: 'throw' });
const schema = new mongoose.Schema({
    owner: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
    requestIds: { type: [String], required: true }, contentHash: { type: String, required: true }, reportVersion: { type: String, required: true },
    title: { type: String, maxlength: 100 }, sourceMode: { type: String, enum: ['manual', 'internal'], required: true },
    sourcePlaylistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Playlist' }, songs: [songSchema],
    status: { type: String, enum: ['pending', 'completed', 'partial', 'error'], required: true },
    // Constructed only by the validated engine, never copied from request/provider objects.
    report: { type: mongoose.Schema.Types.Mixed, default: null }, consentAt: Date,
    processedCount: { type: Number, default: 0 }, totalCount: Number,
    leaseToken: String, leaseUntil: Date, errorCode: { type: String, enum: ['UNAVAILABLE', 'INTERRUPTED', null], default: null },
    createdAt: { type: Date, default: Date.now }, completedAt: Date, expiresAt: { type: Date, required: true },
}, { bufferCommands: false, strict: 'throw' });
schema.index({ owner: 1, requestIds: 1 }, { unique: true });
schema.index({ owner: 1, contentHash: 1 }, { unique: true });
schema.index({ owner: 1, _id: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const PlaylistAnalysis = mongoose.model('PlaylistAnalysis', schema);
