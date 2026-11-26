import { importJWK, jwtVerify } from 'jose';

let cachedKeys: any = null;
let cacheExpiry = 0;

async function getFirebasePublicKeys() {
  const now = Date.now();
  if (cachedKeys && now < cacheExpiry) return cachedKeys;

  const resp = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const cacheControl = resp.headers.get('cache-control');
  const maxAgeMatch = cacheControl?.match(/max-age=(\d+)/);
  const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : 3600;
  
  cachedKeys = await resp.json();
  cacheExpiry = now + (maxAge * 1000);
  return cachedKeys;
}

export async function verifyIdToken(token: string, projectId: string) {
  const jwks = await getFirebasePublicKeys();
  const tokenParts = token.split('.');
  if (tokenParts.length !== 3) throw new Error('Invalid token');
  
  const header = JSON.parse(atob(tokenParts[0]));
  if (header.alg !== 'RS256') throw new Error('Algorithm not RS256');
  
  const keyData = jwks.keys.find((k: any) => k.kid === header.kid);
  if (!keyData) {
    // If key not found, force refresh and retry once
    cachedKeys = null;
    return verifyIdToken(token, projectId);
  }

  const key = await importJWK(keyData, 'RS256');
  const { payload } = await jwtVerify(token, key, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });

  if (!payload.sub || typeof payload.sub !== 'string') throw new Error('Invalid sub');
  if (payload.email_verified !== true) throw new Error('Email not verified');
  
  return { uid: payload.sub, email: payload.email, email_verified: true };
}
