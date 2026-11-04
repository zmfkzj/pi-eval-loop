const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function retry(fn, { retries = 3, baseMs = 100, factor = 2, maxMs = 10000, sleep = realSleep, shouldRetry = () => true } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt > retries || !shouldRetry(error, attempt)) throw error;
      await sleep(Math.min(maxMs, baseMs * factor ** (attempt - 1)));
    }
  }
}
