import { kv, keys } from '../_lib/kv.js';
import webPush from 'web-push';

webPush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:notifly@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

async function callPollinations(sk, messages) {
  const res = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sk}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'nova-fast', messages }),
  });
  if (!res.ok) throw new Error(`Pollinations error: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function fetchGitHubNotifications(token) {
  const res = await fetch(
    'https://api.github.com/notifications?all=false&per_page=50',
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

async function sendDiscord(webhookUrl, digest, appUrl) {
  const embed = {
    title: '🪁 Your Notifly Digest',
    description: digest.slice(0, 4096),
    color: 0x6366f1,
    timestamp: new Date().toISOString(),
    footer: { text: 'View full digest →' },
    url: `${appUrl}/digest`,
  };
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
}

async function sendPush(subscription, appUrl) {
  const payload = JSON.stringify({
    title: 'Your Notifly Digest is ready',
    body: 'Tap to view your AI-generated GitHub summary',
    url: `${appUrl}/digest`,
    icon: '/icons/icon-192.png',
  });
  await webPush.sendNotification(subscription, payload);
}

async function processUser(uid, appUrl) {
  const [token, sk, webhookUrl, pushSubRaw] = await Promise.all([
    kv.get(keys.githubToken(uid)),
    kv.get(keys.pollinationsKey(uid)),
    kv.get(keys.discordWebhook(uid)),
    kv.get(keys.pushSub(uid)),
  ]);

  if (!token || !sk) return; // user hasn't fully set up

  const notifications = await fetchGitHubNotifications(token);
  if (notifications.length === 0) return;

  const notifSummary = notifications
    .slice(0, 30)
    .map(
      (n) =>
        `[${n.reason}] ${n.repository?.full_name}: ${n.subject?.title} (${n.subject?.type})`,
    )
    .join('\n');

  const digest = await callPollinations(sk, [
    {
      role: 'system',
      content:
        'You are a concise GitHub notifications assistant. Create a scannable digest using emoji section headers (🔴 Action Required, 🟡 FYI, ✅ No Action). Highlight action items. Under 300 words.',
    },
    {
      role: 'user',
      content: `Summarize these GitHub notifications:\n\n${notifSummary}`,
    },
  ]);

  const digestRecord = {
    content: digest,
    generated_at: new Date().toISOString(),
    notification_count: notifications.length,
  };

  await kv.set(keys.latestDigest(uid), JSON.stringify(digestRecord));

  const deliveries = [];
  if (webhookUrl) deliveries.push(sendDiscord(webhookUrl, digest, appUrl));
  if (pushSubRaw) {
    try {
      const sub = JSON.parse(pushSubRaw);
      deliveries.push(sendPush(sub, appUrl));
    } catch {
      // malformed push sub — skip
    }
  }

  await Promise.allSettled(deliveries);
}

export default async function handler(req, res) {
  // Vercel cron sends a special header — verify in production
  const authHeader = req.headers['authorization'];
  if (
    process.env.NODE_ENV === 'production' &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    res.status(401).send('Unauthorized');
    return;
  }

  const appUrl = process.env.APP_URL || (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000');

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
