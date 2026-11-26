import { Buffer } from 'node:buffer';

export async function verifyIdToken(token: string, projectId: string): Promise<{ uid: string; email?: string; email_verified?: boolean }> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');

  const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

  // 1. Validate exp, iat, auth_time
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error('Token expired');
  if (payload.iat > now) throw new Error('Token issued in future');

  // 2. Validate aud and iss
  if (payload.aud !== projectId) throw new Error('Invalid audience');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('Invalid issuer');
  if (!payload.sub) throw new Error('Empty sub');

  // 3. Cryptographic Signature Verification
  const jwks = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com').then(r => r.json());
  const key = jwks.keys.find((k: any) => k.kid === header.kid);
  if (!key) throw new Error('Key not found');

  const cryptoKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const isValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    Buffer.from(parts[2], 'base64url'),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );

  if (!isValid) throw new Error('Invalid signature');

  return {
    uid: payload.sub,
    email: payload.email,
    email_verified: payload.email_verified === true
  };
}
