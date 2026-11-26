import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';

type FirebaseJwkSet = {
  keys: (JWK & { kid: string; alg?: string; use?: string; key_ops?: string[] })[];
};

let cachedKeys: FirebaseJwkSet | undefined;
let cacheExpiry = 0;
let inFlightFetch: Promise<FirebaseJwkSet> | undefined;

const GOOGLE_FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CLOCK_SKEW_SECONDS = 5;

async function getFirebasePublicKeys(forceRefresh = false): Promise<FirebaseJwkSet> {
  const now = Date.now();

  if (!forceRefresh && cachedKeys && now < cacheExpiry) {
    return cachedKeys;
  }

  // Coalesce concurrent refreshes within the same Worker isolate.
  if (!forceRefresh && inFlightFetch) return inFlightFetch;

  const fetchKeys = (async () => {
    const response = await fetch(GOOGLE_FIREBASE_JWKS_URL, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Google JWK endpoint returned HTTP ${response.status}`);
    }

    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== 'object' ||
      !Array.isArray((body as { keys?: unknown }).keys) ||
      (body as { keys: unknown[] }).keys.length === 0
    ) {
      throw new Error('Google JWK endpoint returned an invalid key set');
    }

    const keys = (body as FirebaseJwkSet).keys;
    if (
      keys.some(
        (key) =>
          !key ||
          typeof key !== 'object' ||
          typeof key.kid !== 'string' ||
          !key.kid ||
          key.kty !== 'RSA' ||
          (key.alg !== undefined && key.alg !== 'RS256') ||
          (key.use !== undefined && key.use !== 'sig') ||
          (key.key_ops !== undefined && !key.key_ops.includes('verify')),
      )
    ) {
      throw new Error('Google JWK endpoint returned an invalid signing key');
    }

    const cacheControl = response.headers.get('cache-control') ?? '';
    const maxAgeMatch = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i);
    const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;

    cachedKeys = { keys };
    cacheExpiry = Date.now() + maxAgeSeconds * 1000;
    return cachedKeys;
  })();

  if (!forceRefresh) inFlightFetch = fetchKeys;

  try {
    return await fetchKeys;
  } finally {
    if (inFlightFetch === fetchKeys) inFlightFetch = undefined;
  }
}

export async function verifyIdToken(token: string, projectId: string) {
  if (!projectId || !projectId.trim()) throw new Error('Firebase project ID is required');
  if (typeof token !== 'string' || !token) throw new Error('Firebase ID token is required');

  const header = decodeProtectedHeader(token);
  if (header.alg !== 'RS256') throw new Error('Firebase ID token must use RS256');
  if (typeof header.kid !== 'string' || !header.kid) {
    throw new Error('Firebase ID token is missing its key ID');
  }

  let jwks = await getFirebasePublicKeys();
  let keyData = jwks.keys.find((key) => key.kid === header.kid);

  // A newly rotated Google signing key may not be in the cached set.
  // Force exactly one refresh; never recurse or retry indefinitely.
  if (!keyData) {
    jwks = await getFirebasePublicKeys(true);
    keyData = jwks.keys.find((key) => key.kid === header.kid);
  }
  if (!keyData) throw new Error('Firebase signing key was not found');

  const key = await importJWK(keyData, 'RS256');
  const nowSeconds = Math.floor(Date.now() / 1000);

  const { payload } = await jwtVerify(token, key, {
    algorithms: ['RS256'],
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    requiredClaims: ['exp', 'iat', 'auth_time', 'sub'],
    clockTolerance: CLOCK_SKEW_SECONDS,
  });

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('Firebase ID token has an invalid subject');
  }
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new Error('Firebase ID token has an invalid expiration');
  }
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    throw new Error('Firebase ID token has an invalid issued-at time');
  }
  if (typeof payload.auth_time !== 'number' || !Number.isFinite(payload.auth_time)) {
    throw new Error('Firebase ID token has an invalid authentication time');
  }
  if (payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error('Firebase ID token was issued in the future');
  }
  if (payload.auth_time > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error('Firebase ID token has a future authentication time');
  }
  if (payload.auth_time > payload.iat + CLOCK_SKEW_SECONDS) {
    throw new Error('Firebase ID token authentication time is after issuance');
  }
  if (payload.email_verified !== true) {
    throw new Error('Firebase email address is not verified');
  }

  return {
    uid: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    email_verified: true as const,
  };
}
