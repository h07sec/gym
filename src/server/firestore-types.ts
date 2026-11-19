export interface DbDocSnap {
  readonly id: string;
  readonly exists: boolean;
  readonly ref: DbDocRef;
  data(): Record<string, unknown> | undefined;
}

export interface DbQueryDocSnap extends DbDocSnap {
  data(): Record<string, unknown>;
}

export interface DbQuerySnap {
  readonly empty: boolean;
  readonly docs: DbQueryDocSnap[];
}

export interface DbQuery {
  where(fieldPath: string, opStr: '==' | '<=' | '<' | '>' | '>=', value: unknown): DbQuery;
  orderBy(fieldPath: string, directionStr?: 'asc' | 'desc'): DbQuery;
  limit(limit: number): DbQuery;
  startAfter(...fieldValues: unknown[]): DbQuery;
  get(): Promise<DbQuerySnap>;
}

export interface DbCollection extends DbQuery {
  doc(documentPath?: string): DbDocRef;
}

export interface DbDocRef {
  readonly id: string;
  readonly path: string;
  collection(collectionPath: string): DbCollection;
  get(): Promise<DbDocSnap>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
  update(data: Record<string, unknown>): Promise<unknown>;
}

export interface DbTransaction {
  get(ref: DbDocRef): Promise<DbDocSnap>;
  get(query: DbQuery): Promise<DbQuerySnap>;
  set(ref: DbDocRef, data: Record<string, unknown>, options?: { merge?: boolean }): unknown;
  update(ref: DbDocRef, data: Record<string, unknown>): unknown;
}

export interface DbClient {
  collection(collectionPath: string): DbCollection;
  runTransaction<T>(updateFunction: (tx: DbTransaction) => Promise<T>): Promise<T>;
}

export function isTransientFirestoreError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === 4 || code === 8 || code === 10 || code === 14) return true;
  if (
    typeof code === 'string' &&
    ['deadline-exceeded', 'resource-exhausted', 'aborted', 'unavailable'].includes(
      code.toLowerCase()
    )
  ) {
    return true;
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  return (
    msg.includes('deadline exceeded') ||
    msg.includes('unavailable') ||
    msg.includes('aborted') ||
    msg.includes('try again')
  );
}

export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  options?: { maxAttempts?: number; baseDelayMs?: number }
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 150;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isTransientFirestoreError(err)) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export function timestampValueToMillis(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'object' && value !== null) {
    const maybe = value as { toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof maybe.toMillis === 'function') {
      return maybe.toMillis();
    }
    const secs =
      typeof maybe.seconds === 'number'
        ? maybe.seconds
        : typeof maybe._seconds === 'number'
          ? maybe._seconds
          : null;
    if (secs !== null) {
      return secs * 1000;
    }
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}
