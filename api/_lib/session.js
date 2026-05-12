import { kv, keys } from './kv.js';
import { parse as parseCookies } from 'cookie';
import { randomBytes, createHmac } from 'crypto';

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

function sign(value, secret) {
  const mac = createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${mac}`;
}

function verify(signed, secret) {
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const expected = sign(value, secret).split('.').pop();
  const actual = signed.slice(idx + 1);
  if (actual !== expected) return null;
  return value;
}

export async function createSession(uid) {
  const sid = randomBytes(24).toString('base64url');
  await kv.set(keys.session(sid), uid, { ex: SESSION_TTL });
  const signed = sign(sid, process.env.SESSION_SECRET);
  return signed;
}

export async function getSessionUid(req) {
  const cookieHeader = req.headers['cookie'] || '';
  const cookies = parseCookies(cookieHeader);
  const signed = cookies['notifly_session'];
  if (!signed) return null;
  const sid = verify(signed, process.env.SESSION_SECRET);
  if (!sid) return null;
  return kv.get(keys.session(sid));
}

export function sessionCookieHeader(signedSid) {
  return `notifly_session=${signedSid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;
}
