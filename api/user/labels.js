import { kv, keys } from '../_lib/kv.js';
import { getSessionUid } from '../_lib/session.js';

export default async function handler(req, res) {
  const uid = await getSessionUid(req);
  if (!uid) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  if (req.method === 'GET') {
    const [aiLabels, aiPriorities] = await Promise.all([
      kv.get(keys.aiLabels(uid)),
      kv.get(keys.aiPriorities(uid)),
    ]);

    res.status(200).json({
      ai_labels: aiLabels ? JSON.parse(aiLabels) : {},
      ai_priorities: aiPriorities ? JSON.parse(aiPriorities) : {},
    });
    return;
  }

  if (req.method === 'POST') {
    const { ai_labels, ai_priorities } = req.body || {};

    const writes = [];
    if (ai_labels !== undefined) {
      writes.push(kv.set(keys.aiLabels(uid), JSON.stringify(ai_labels)));
    }
    if (ai_priorities !== undefined) {
      writes.push(kv.set(keys.aiPriorities(uid), JSON.stringify(ai_priorities)));
    }

    await Promise.all(writes);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
