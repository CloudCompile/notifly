import { createClient } from '@vercel/kv';

export const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// User record keys — all scoped by GitHub user ID
export const keys = {
  githubToken: (uid) => `user:${uid}:github_token`,
  pollinationsKey: (uid) => `user:${uid}:pollinations_key`,
  discordWebhook: (uid) => `user:${uid}:discord_webhook`,
  digestSchedule: (uid) => `user:${uid}:digest_schedule`,
  pushSub: (uid) => `user:${uid}:push_sub`,
  latestDigest: (uid) => `user:${uid}:latest_digest`,
  aiLabels: (uid) => `user:${uid}:ai_labels`,
  aiPriorities: (uid) => `user:${uid}:ai_priorities`,
  pushNotifEnabled: (uid) => `user:${uid}:push_notif_enabled`,
  lastNotifCheck: (uid) => `user:${uid}:last_notif_check`,
  // maps session id → uid
  session: (sid) => `session:${sid}`,
  // set of all user ids for cron iteration
  allUsers: 'users:all',
};
