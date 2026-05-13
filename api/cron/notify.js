import { kv, keys } from '../_lib/kv.js';
import webPush from 'web-push';

webPush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:notifly@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

async function fetchNewNotifications(token, since) {
  const sinceParam = since ? `&since=${encodeURIComponent(since)}` : '';
  const res = await fetch(
    `https://api.github.com/notifications?all=false&per_page=20${sinceParam}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Notifly',
        Accept: 'application/vnd.github.v3+json',
      },
    },
  );
  if (!res.ok) return [];
  return res.json();
}

function reasonLabel(reason) {
  const map = {
    mention: 'You were mentioned',
    review_requested: 'Review requested',
    assign: 'You were assigned',
    author: 'Activity on your item',
    comment: 'New comment',
    ci_activity: 'CI activity',
    push: 'New push',
    subscribed: 'Update',
    team_mention: 'Team mention',
  };
  return map[reason] || reason?.replace(/_/g, ' ') || 'New notification';
}

async function processUser(uid, appUrl) {
  const [token, pushSubRaw, enabled] = await Promise.all([
    kv.get(keys.githubToken(uid)),
    kv.get(keys.pushSub(uid)),
    kv.get(keys.pushNotifEnabled(uid)),
  ]);

  if (!token || !pushSubRaw || !enabled) return;

  let pushSub;
  try {
    pushSub = JSON.parse(pushSubRaw);
  } catch {
    return;
  }

  const since = await kv.get(keys.lastNotifCheck(uid));
  const now = new Date().toISOString();

  const notifications = await fetchNewNotifications(token, since);

  // Update check timestamp regardless of results
  await kv.set(keys.lastNotifCheck(uid), now);

  if (!notifications.length) return;

  // Send up to 5 individual push notifications to avoid flooding
  const toSend = notifications.slice(0, 5);
  const sends = toSend.map((n) => {
    const payload = JSON.stringify({
      title: reasonLabel(n.reason),
      body: `${n.repository?.full_name}: ${n.subject?.title}`,
      url: `${appUrl}/#/inbox/all`,
      icon: '/icons/icon-192.png',
      tag: `notif-${n.id}`,
    });
    return webPush.sendNotification(pushSub, payload).catch(() => {});
  });

  if (notifications.length > 5) {
    // Send a summary for the rest
    const extra = notifications.length - 5;
    const payload = JSON.stringify({
      title: `+${extra} more notification${extra > 1 ? 's' : ''}`,
      body: 'Open Notifly to see everything',
      url: `${appUrl}/#/inbox/all`,
      icon: '/icons/icon-192.png',
      tag: 'notif-overflow',
    });
    sends.push(webPush.sendNotification(pushSub, payload).catch(() => {}));
  }

  await Promise.allSettled(sends);
}

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (
    process.env.NODE_ENV === 'production' &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    res.status(401).send('Unauthorized');
    return;
  }

  const appUrl = process.env.APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  const userIds = await kv.smembers(keys.allUsers);
  if (!userIds?.length) {
    res.status(200).json({ processed: 0 });
    return;
  }

  const results = await Promise.allSettled(
    userIds.map((uid) => processUser(uid, appUrl)),
  );

  const failed = results.filter((r) => r.status === 'rejected').length;
  res.status(200).json({ processed: userIds.length, failed });
}
