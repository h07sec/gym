import { importJWK, jwtVerify } from 'jose';

let cachedKeys: any = null;
let cacheExpiry = 0;

async function getFirebasePublicKeys(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedKeys && now < cacheExpiry) return cachedKeys;

  const resp = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  if (!resp.ok) throw new Error(`Failed to fetch JWKs: ${resp.status}`);
  
  const cacheControl = resp.headers.get('cache-control');
  const maxAgeMatch = cacheControl?.match(/max-age=(\d+)/);
  const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : 3600;
  
  cachedKeys = await resp.json();
  cacheExpiry = now + (maxAge * 1000);
  return cachedKeys;
}

export async function verifyIdToken(token: string, projectId: string, retry = true) {
  const jwks = await getFirebasePublicKeys();
  const tokenParts = token.split('.');
  if (tokenParts.length !== 3) throw new Error('Invalid token');
  
  const header = JSON.parse(atob(tokenParts[0]));
  if (header.alg !== 'RS256') throw new Error('Algorithm not RS256');
  
  const keyData = jwks.keys.find((k: any) => k.kid === header.kid);
  if (!keyData) {
    if (retry) {
      cachedKeys = null;
      return verifyIdToken(token, projectId, false); // Exactly one retry
    }
    throw new Error('Key not found');
  }

  const key = await importJWK(keyData, 'RS256');
  const { payload } = await jwtVerify(token, key, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });

  // Strict claim validation
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('Invalid sub');
  if (typeof payload.exp !== 'number') throw new Error('Invalid exp');
  if (typeof payload.iat !== 'number') throw new Error('Invalid iat');
  if (typeof payload.auth_time !== 'number') throw new Error('Invalid auth_time');
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  if (payload.email_verified !== true) throw new Error('Email not verified');
  
  return { uid: payload.sub, email: payload.email, email_verified: true };
}
