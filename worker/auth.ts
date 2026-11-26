// Placeholder for JWT verification
export async function verifyIdToken(token: string, projectId: string): Promise<{ uid: string; email?: string; email_verified?: boolean }> {
  // TODO: Implement Web Crypto RS256 validation against Google JWKs
  // Returning mock for scaffold stability until full implementation
  if (token === 'mock-token') {
    return { uid: 'user_123', email: 'test@example.com', email_verified: true };
  }
  throw new Error('Unauthorized');
}
