import { kv, keys } from '../_lib/kv.js';
import { getSessionUid } from '../_lib/session.js';

export default async function handler(req, res) {
  const uid = await getSessionUid(req);
  if (!uid) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const [discordWebhook, digestSchedule, latestDigest] = await Promise.all([
    kv.get(keys.discordWebhook(uid)),
    kv.get(keys.digestSchedule(uid)),
    kv.get(keys.latestDigest(uid)),
  ]);

  res.status(200).json({
    uid,
    discord_webhook: discordWebhook,
    digest_schedule: digestSchedule,
    latest_digest: latestDigest,
  });
}
