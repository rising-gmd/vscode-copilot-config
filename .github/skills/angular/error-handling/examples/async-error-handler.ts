/**
 * Example pattern for handling async errors in tasks
 */
export async function runSafe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); } catch (e) { console.error('Async error', e); return undefined; }
}
