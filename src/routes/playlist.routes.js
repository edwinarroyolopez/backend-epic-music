import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware.js';
import { User } from '../models/user.model.js';
import { Playlist, serializePlaylist } from '../models/playlist.model.js';
import { PlaylistError, objectId, fields, invalid, metadata, songInputs, createPlaylist, ownedPlaylist, mutatePlaylist, addSongs } from '../services/playlist.service.js';

export const playlistRoutes = Router();
playlistRoutes.use(authenticateToken);
playlistRoutes.use(async (req, _res, next) => {
    if (typeof req.user.sub !== 'string' || !/^[a-f\d]{24}$/i.test(req.user.sub)) throw new PlaylistError('UNAUTHORIZED', 401);
    const user = await User.findById(req.user.sub).select('active');
    if (!user) throw new PlaylistError('UNAUTHORIZED', 401);
    if (!user.active) throw new PlaylistError('ACCOUNT_DISABLED', 403);
    next();
});
const send = (res, { doc, ...extra }, status = 200) => res.status(status).json({ success: true, data: { playlist: serializePlaylist(doc), ...extra } });
playlistRoutes.get('/', async (req, res) => {
    const docs = await Playlist.find({ owner: req.user.sub }).sort({ updatedAt: -1, _id: -1 });
    res.json({ success: true, data: { playlists: docs.map(doc => serializePlaylist(doc, true)) } });
});
playlistRoutes.post('/', async (req, res) => send(res, await createPlaylist(req.user.sub, req.body), 201));
playlistRoutes.get('/:playlistId', async (req, res) => send(res, { doc: await ownedPlaylist(req.user.sub, req.params.playlistId) }));
playlistRoutes.patch('/:playlistId', async (req, res) => {
    const changes = metadata(req.body);
    send(res, await mutatePlaylist(req.user.sub, req.params.playlistId, doc => { Object.assign(doc, changes); }));
});
playlistRoutes.delete('/:playlistId', async (req, res) => {
    const result = await Playlist.deleteOne({ _id: objectId(req.params.playlistId), owner: req.user.sub });
    if (!result.deletedCount) throw new PlaylistError('NOT_FOUND', 404);
    res.json({ success: true, data: { deleted: true } });
});
playlistRoutes.post('/:playlistId/songs', async (req, res) => {
    fields(req.body, ['songs']);
    send(res, await addSongs(req.user.sub, req.params.playlistId, songInputs(req.body.songs)));
});
playlistRoutes.delete('/:playlistId/songs/:songId', async (req, res) => {
    const id = objectId(req.params.songId);
    send(res, await mutatePlaylist(req.user.sub, req.params.playlistId, doc => {
        const song = doc.songs.id(id);
        if (!song) throw new PlaylistError('NOT_FOUND', 404);
        song.deleteOne();
    }));
});
playlistRoutes.patch('/:playlistId/songs/order', async (req, res) => {
    fields(req.body, ['songIds']);
    if (!Array.isArray(req.body.songIds) || req.body.songIds.length > 500) invalid();
    const ids = req.body.songIds.map(objectId);
    if (new Set(ids).size !== ids.length) invalid();
    send(res, await mutatePlaylist(req.user.sub, req.params.playlistId, doc => {
        if (ids.length !== doc.songs.length || ids.some(id => !doc.songs.id(id))) throw new PlaylistError('CONFLICT', 409, 'El orden no coincide con las canciones actuales');
        doc.songs = ids.map(id => doc.songs.id(id).toObject());
    }));
});
playlistRoutes.use((error, _req, res, _next) => {
    const known = error instanceof PlaylistError;
    res.status(known ? error.status : 500).json({ success: false, error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'Error interno' } });
});
