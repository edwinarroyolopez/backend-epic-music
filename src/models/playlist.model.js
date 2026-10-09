import mongoose from 'mongoose';

const songSchema = new mongoose.Schema({
    songId: { type: mongoose.Schema.Types.ObjectId, ref: 'Song' },
    edition: { type: String, maxlength: 200 },
    title: { type: String, required: true },
    artist: { type: String, required: true },
    genre: String,
    album: String,
    releaseYear: Number,
    reason: String,
    originType: { type: String, enum: ['identified', 'recommendation'], required: true },
    catalogVerified: { type: Boolean, default: false, immutable: true },
    normalizedKey: { type: String, required: true },
    addedAt: { type: Date, default: Date.now },
});
const playlistSchema = new mongoose.Schema({
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    slot: { type: Number, required: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    songs: { type: [songSchema], default: [] },
}, { timestamps: true, optimisticConcurrency: true });
playlistSchema.index({ owner: 1, slot: 1 }, { unique: true });
playlistSchema.index({ owner: 1, updatedAt: -1 });
export const Playlist = mongoose.model('Playlist', playlistSchema);

export function serializePlaylist(doc, summary = false) {
    const value = doc.toObject ? doc.toObject() : doc;
    return {
        id: String(value._id), name: value.name, description: value.description,
        songCount: value.songs.length, createdAt: value.createdAt, updatedAt: value.updatedAt,
        ...(!summary && { songs: value.songs.map(({ _id, normalizedKey: _key, ...song }) => ({ id: String(_id), ...song, catalogVerified: false })) }),
    };
}
