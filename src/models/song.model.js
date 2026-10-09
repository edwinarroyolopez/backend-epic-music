import mongoose from 'mongoose';

// NFC deliberately preserves compatibility characters, punctuation and accents.
export const songIdentityPart = value => value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
export const canonicalSongKey = ({ title, artist, edition = '' }) => JSON.stringify([title, artist, edition || ''].map(songIdentityPart));
const nested = { _id: false, strict: true };
const lease = new mongoose.Schema({ token: String, expiresAt: Date }, nested);
const source = new mongoose.Schema({ name: { type: String, maxlength: 100 }, recordId: { type: String, maxlength: 200 }, url: { type: String, maxlength: 500 } }, nested);
const lyrics = new mongoose.Schema({
    status: { type: String, enum: ['never_attempted', 'in_progress', 'available', 'transient', 'not_found', 'instrumental', 'temporary_error', 'rights_restricted'], default: 'never_attempted' },
    lookupAttempted: { type: Boolean, default: false }, firstAttemptAt: { type: Date, default: null }, completedAt: { type: Date, default: null },
    source: { type: source, default: null }, text: { type: String, maxlength: 60000, default: null }, contentVersion: { type: String, default: null },
    rights: { type: new mongoose.Schema({ authorized: Boolean, reference: { type: String, maxlength: 500 } }, nested), default: null },
    lastErrorCode: { type: String, default: null }, attemptCount: { type: Number, default: 0, min: 0 },
    retryAt: { type: Date, default: null }, lease: { type: lease, default: null },
}, nested);
const analysis = new mongoose.Schema({
    status: { type: String, enum: ['not_started', 'in_progress', 'estimated', 'insufficient_evidence', 'unavailable', 'not_applicable'], default: 'not_started' },
    method: { type: String, enum: ['ai_lyrics'], default: 'ai_lyrics' }, scope: { type: String, enum: ['lyrics'], default: 'lyrics' }, scale: { type: String, enum: ['relative_percent'], default: 'relative_percent' },
    version: { type: String, default: null }, sourceContentVersion: { type: String, default: null }, sampled: { type: Boolean, default: false },
    provider: { type: String, maxlength: 40, default: null }, model: { type: String, maxlength: 200, default: null },
    analyzedAt: { type: Date, default: null }, lastErrorCode: { type: String, default: null }, retryAt: { type: Date, default: null },
    attemptCount: { type: Number, default: 0, min: 0 }, lease: { type: lease, default: null },
}, nested);
const schema = new mongoose.Schema({
    title: { type: String, required: true, maxlength: 200, immutable: true },
    artist: { type: String, required: true, maxlength: 200, immutable: true },
    edition: { type: String, maxlength: 200, default: '', immutable: true },
    canonicalKey: { type: String, required: true, immutable: true },
    catalogVerified: { type: Boolean, default: false, immutable: true, validate: v => v === false },
    lyrics: { type: lyrics, default: () => ({}) },
    emotions: { type: [new mongoose.Schema({ code: String, score: Number }, nested)], default: [] },
    emotionAnalysis: { type: analysis, default: () => ({}) },
}, { timestamps: true, bufferCommands: false });
schema.index({ canonicalKey: 1 }, { unique: true });
schema.pre('validate', function () {
    if (this.canonicalKey !== canonicalSongKey(this)) this.invalidate('canonicalKey', 'Identity mismatch');
    const l = this.lyrics;
    if (l.lookupAttempted !== (l.status !== 'never_attempted') || l.lookupAttempted !== Boolean(l.firstAttemptAt)) this.invalidate('lyrics', 'Attempt invariant');
    if (l.status === 'available' && (!l.text?.trim() || !l.contentVersion || !l.rights?.authorized || !l.rights.reference)) this.invalidate('lyrics', 'Authorized content required');
    if (l.status !== 'available' && l.text !== null) this.invalidate('lyrics.text', 'Text forbidden in this state');
    if (l.status === 'transient' && !l.contentVersion) this.invalidate('lyrics.contentVersion', 'Transient content fingerprint required');
    if (l.status === 'never_attempted' && (l.attemptCount !== 0 || l.completedAt || l.lease)) this.invalidate('lyrics', 'Never attempted invariant');
    if (l.lookupAttempted && l.attemptCount < 1) this.invalidate('lyrics.attemptCount', 'Attempt required');
    if (l.status === 'in_progress' && (!l.lease?.token || !l.lease.expiresAt)) this.invalidate('lyrics.lease', 'Lease required');
    if (!['never_attempted', 'in_progress'].includes(l.status) && (!l.completedAt || l.lease)) this.invalidate('lyrics', 'Completion invariant');
    const a = this.emotionAnalysis, values = this.emotions;
    if (a.status === 'in_progress' && (!a.lease?.token || !a.lease.expiresAt)) this.invalidate('emotionAnalysis.lease', 'Lease required');
    // Analysis can outlive a transient body. It is reusable only with this hash.
    if (['estimated', 'insufficient_evidence'].includes(a.status) && (!l.lookupAttempted || !l.contentVersion || a.sourceContentVersion !== l.contentVersion || !a.version || !a.analyzedAt)) this.invalidate('emotionAnalysis', 'Content version invariant');
    if (a.status === 'estimated' && (values.length !== 3 || new Set(values.map(v => v.code)).size !== 3 ||
        values.some((v, i) => !['joy', 'sadness', 'anger', 'fear', 'love', 'hope', 'nostalgia', 'calm'].includes(v.code) || !Number.isInteger(v.score) || v.score < 1 || v.score > 100 || (i && values[i - 1].score < v.score)) ||
        values.reduce((sum, v) => sum + v.score, 0) !== 100)) this.invalidate('emotions', 'Invalid relative weights');
});
export const Song = mongoose.model('Song', schema);

export function songSummary(doc) {
    return { songId: String(doc._id), title: doc.title, artist: doc.artist, edition: doc.edition,
        catalogVerified: false, lookupAttempted: doc.lyrics.lookupAttempted, lyricsLookupStatus: doc.lyrics.status };
}
