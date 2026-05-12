import { kv, keys } from '../_lib/kv.js';
import { createSession, sessionCookieHeader } from '../_lib/session.js';

export default async function handler(req, res) {
  const { code } = req.query;
  if (!code) {
    res.status(400).send('Missing OAuth code');
    return;
  }

  // Exchange code for access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  if (!accessToken) {
    res.status(400).send('OAuth token exchange failed');
    return;
  }

  // Fetch GitHub user to get stable uid
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'Notifly' },
  });
  const user = await userRes.json();
  const uid = String(user.id);

  // Persist token and register user
  await kv.set(keys.githubToken(uid), accessToken);
  await kv.sadd(keys.allUsers, uid);

  const sid = await createSession(uid);

  // Redirect back to app — token also passed in fragment for localStorage storage
  const appUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  const pollinationsAppKey = process.env.POLLINATIONS_APP_KEY || '';
  const redirectUri = encodeURIComponent(`${appUrl}`);

  res.setHeader('Set-Cookie', sessionCookieHeader(sid));
  // Pass token in fragment so JS can store in localStorage, then kick off BYOP flow
  res.redirect(
    302,
    `${appUrl}/#auth_token=${accessToken}&uid=${uid}&pollinations_key=${pollinationsAppKey}&redirect_uri=${redirectUri}`,
  );
}
