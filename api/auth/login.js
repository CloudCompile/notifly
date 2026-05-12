export default function handler(req, res) {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'}/api/auth/callback`,
    scope: 'notifications read:user',
    state: Math.random().toString(36).slice(2),
  });
  res.redirect(302, `https://github.com/login/oauth/authorize?${params}`);
}
