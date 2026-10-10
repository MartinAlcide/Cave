import { replicateGoogleDrive } from 'rxdb/plugins/replication-google-drive';
import { replicateRxCollection } from 'rxdb/plugins/replication';
import { parseCave } from './storage.js';

export function isAuthenticationError(error) {
  // Walk only error wrappers, never snapshot content or timestamps in pushRows.
  if (!error || typeof error !== 'object') return false;
  const params = error.parameters || error;
  const status = params.status ?? error.status;
  if (status === 401) return true;
  if (status === 403) {
    try {
      const body = JSON.parse(params.errorText || '{}');
      if (body.error?.errors?.some(item => ['authError', 'insufficientPermissions'].includes(item.reason))) return true;
    } catch { /* Not a JSON response; treat as a normal sync error. */ }
  }
  return (params.errors || []).some(isAuthenticationError) || isAuthenticationError(error.cause) ||
    /^files\.list failed: 401\b/.test(error.message || '');
}

const active = new WeakSet();
export async function syncOnce(store, session, {
  signal,
  timeout = 120_000,
  googleDrive = {}
} = {}) {
  if (active.has(store)) throw new Error('Une synchronisation est déjà en cours.');
  active.add(store);
  try {
    return await runSyncOnce(store, session, { signal, timeout, googleDrive });
  } finally {
    active.delete(store);
  }
}

async function runSyncOnce(store, session, { signal, timeout, googleDrive }) {
  if (signal?.aborted) throw new Error('Synchronisation annulée.');
  if (globalThis.navigator?.onLine === false) throw new Error('Synchronisation indisponible hors ligne.');
  if (session.expiresAt <= Date.now() + 30_000) {
    throw Object.assign(new Error('Jeton expiré, reconnectez-vous.'), { status: 401 });
  }
  await store.flush();
  let state;
  let subscription;
  let stopped = false;
  let cancellation;
  let fail;
  const failed = new Promise((_, reject) => { fail = reject; });
  const stop = error => {
    if (stopped) return;
    stopped = true;
    cancellation = state?.cancel();
    fail(error);
  };
  const abort = () => stop(new Error('Synchronisation annulée.'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => stop(new Error('Délai de synchronisation dépassé.')), timeout);
  const run = async () => {
    if (stopped) throw new Error('Synchronisation annulée.');
    const connector = await replicateGoogleDrive({
      collection: store.collection,
      replicationIdentifier: `cave-drive-v1-${session.clientId}-${session.accountId}`,
      googleDrive: {
        oauthClientId: session.clientId,
        authToken: session.token,
        space: 'appDataFolder',
        folderPath: 'cave-v1',
        ...googleDrive
      },
      live: false,
      autoStart: false,
      waitForLeadership: false,
      pull: { modifier: doc => {
        if (doc.id !== 'cave' || doc._deleted) throw new Error('Document Drive inattendu.');
        parseCave(doc.content);
        return doc;
      } },
      push: {}
    });
    // RxDB 17.6.0 queues non-live cancel() behind its first sync, which hangs on
    // errors. Reuse the official connector's public pull/push handlers in the
    // standard engine instead. No signaling, custom Drive protocol or internals.
    await connector.cancel(); // Never started, so this cancellation is safe.
    if (stopped || signal?.aborted) return;
    state = replicateRxCollection({
      collection: store.collection,
      replicationIdentifier: connector.replicationIdentifier,
      pull: connector.pull,
      push: connector.push,
      live: true, // Only for this bounded, explicitly requested session.
      autoStart: false,
      waitForLeadership: false,
      toggleOnDocumentVisible: false,
      retryTime: 1000
    });
    subscription = state.error$.subscribe(stop);
    await state.start();
    await state.awaitInSync();
  };
  try {
    await Promise.race([run(), failed]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    subscription?.unsubscribe();
    await (cancellation || state?.cancel());
  }
}
