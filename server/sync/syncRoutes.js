/**
 * Sync admin routes — local-only monitoring + manual control.
 *
 *   GET    /api/sync/status     → queue counts, online state, last success
 *   GET    /api/sync/pending    → list pending uploads (paginated)
 *   GET    /api/sync/dead       → list permanently failed uploads
 *   POST   /api/sync/drain      → manually trigger an immediate drain
 *   POST   /api/sync/retry/:id  → requeue a failed/dead record
 *   DELETE /api/sync/purge      → clear all `synced` rows older than N days
 */
const express   = require('express');
const router    = express.Router();
const SyncQueue = require('./SyncQueue');
const svc       = require('./syncService');

router.get('/status', async (_req, res) => {
  res.json(await svc.getStatus());
});

router.get('/pending', async (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit || '50', 10));
  const rows = await SyncQueue.find({ status: { $in: ['pending','uploading','failed'] } })
    .sort({ createdAt: -1 }).limit(limit);
  res.json({ rows });
});

router.get('/dead', async (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit || '50', 10));
  const rows = await SyncQueue.find({ status: 'dead' })
    .sort({ createdAt: -1 }).limit(limit);
  res.json({ rows });
});

router.post('/drain', async (_req, res) => {
  const r = await svc.drainOnce();
  res.json(r);
});

router.post('/retry/:id', async (req, res) => {
  const updated = await SyncQueue.findByIdAndUpdate(
    req.params.id,
    { $set: { status: 'pending', nextAttemptAt: new Date(), lastError: null } },
    { new: true }
  );
  if (!updated) return res.status(404).json({ error: 'not-found' });
  res.json({ success: true, row: updated });
});

router.delete('/purge', async (req, res) => {
  const days = Math.max(1, parseInt(req.query.olderThanDays || '7', 10));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const r = await SyncQueue.deleteMany({ status: 'synced', syncedAt: { $lt: cutoff } });
  res.json({ deleted: r.deletedCount });
});

module.exports = router;
