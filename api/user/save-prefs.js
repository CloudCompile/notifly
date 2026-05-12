import { kv, keys } from '../_lib/kv.js';
import { getSessionUid } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const uid = await getSessionUid(req);
  if (!uid) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  const updates = [];

  if (body.pollinations_key) {
    updates.push(kv.set(keys.pollinationsKey(uid), body.pollinations_key));
  }
  if (body.discord_webhook) {
    updates.push(kv.set(keys.discordWebhook(uid), body.discord_webhook));
  }
  if (body.digest_schedule) {
    updates.push(kv.set(keys.digestSchedule(uid), body.digest_schedule));
  }
  if (body.push_sub) {
    updates.push(kv.set(keys.pushSub(uid), JSON.stringify(body.push_sub)));
  }
  if (body.push_notif_enabled !== undefined) {
    updates.push(
      body.push_notif_enabled
        ? kv.set(keys.pushNotifEnabled(uid), '1')
        : kv.del(keys.pushNotifEnabled(uid)),
    );
  }

  await Promise.all(updates);
  res.status(200).json({ ok: true });
}
