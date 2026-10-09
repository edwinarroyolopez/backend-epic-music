import mongoose from 'mongoose';
import { displayText, identityKey, matchKey, grams } from '../services/search-normalization.js';

export function artistKeys(canonicalName, aliases = []) {
    const names = [canonicalName, ...aliases.slice(0, 20)];
    return {
        normalizedKey: identityKey(canonicalName),
        searchKeys: [...new Set(names.map(matchKey))],
        grams: [...new Set(names.flatMap(grams))],
    };
}
const schema = new mongoose.Schema({
    canonicalName: { type: String, required: true, maxlength: 200 },
    normalizedKey: { type: String, required: true },
    aliases: { type: [String], default: [], validate: values => values.length <= 20 && values.every(v => v.length <= 200) },
    searchKeys: [String], grams: [String],
    validationStatus: { type: String, enum: ['curated', 'model_inferred'], required: true },
    source: { type: String, enum: ['curation', 'lyrics_identification'], required: true },
    usageCount: { type: Number, default: 0 },
}, { timestamps: true, bufferCommands: false });
schema.pre('validate', function () {
    this.canonicalName = displayText(this.canonicalName);
    Object.assign(this, artistKeys(this.canonicalName, this.aliases));
});
schema.index({ normalizedKey: 1 }, { unique: true });
schema.index({ searchKeys: 1 });
schema.index({ grams: 1 });
export const Artist = mongoose.model('Artist', schema);
