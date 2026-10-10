import 'fake-indexeddb/auto';
import { test, before, after } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { startServer } from 'google-drive-mock';
import { openCave } from '../src/storage.js';
import { syncOnce, isAuthenticationError } from '../src/drive.js';

const snapshot = { bottles: [{ id: 'wine-1', color: 'rouge', pays: 'France', region: 'Bourgogne',
  appellation: 'Volnay', domaine: 'Domaine test', cuvee: '', millesime: '2020',
  quantity: 3, format: 75, location: 'Casier A' }], lastModified: 123456789 };
const session = { clientId: 'test-client', accountId: 'test-account', token: 'valid-token',
  expiresAt: Date.now() + 3_600_000 };
let server;
let apiEndpoint;
before(async () => {
  const config = {};
  server = startServer(0, '127.0.0.1', config);
  await once(server, 'listening');
  apiEndpoint = config.apiEndpoint = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));

async function device(t, chooseConflict) {
  const store = await openCave({ name: `cave-test-${crypto.randomUUID()}`,
    legacyStorage: { getItem: () => null }, multiInstance: false, chooseConflict });
  t.after(() => store.close());
  return store;
}
const options = () => ({ timeout: 15_000,
  googleDrive: { apiEndpoint, folderPath: `cave-${crypto.randomUUID()}` } });

test('deux appareils, checkpoints, éditions et suppressions, uniquement sur demande', async t => {
  const config = options();
  const a = await device(t);
  const b = await device(t);
  await a.save(snapshot);
  assert.equal((await b.read()).bottles.length, 0);
  await syncOnce(a, session, config);
  await syncOnce(b, session, config);
  assert.deepEqual(await b.read(), snapshot);
  await a.save({ bottles: [], lastModified: 999 });
  assert.deepEqual(await b.read(), snapshot);
  await syncOnce(a, session, config);
  await syncOnce(b, session, config);
  assert.deepEqual(await b.read(), { bottles: [], lastModified: 999 });
});

for (const choice of ['local', 'remote']) {
  test(`conflit : aucun écrasement avant le choix ${choice}`, async t => {
    const config = options();
    const a = await device(t);
    let answer;
    let seen;
    let notify;
    const asked = new Promise(resolve => { notify = resolve; });
    const b = await device(t, input => {
      seen = input;
      notify();
      return new Promise(resolve => { answer = resolve; });
    });
    await a.save(snapshot);
    await syncOnce(a, session, config);
    await syncOnce(b, session, config);
    const remote = { ...snapshot, lastModified: 200, bottles: [{ ...snapshot.bottles[0], quantity: 5 }] };
    const local = { ...snapshot, lastModified: 300, bottles: [{ ...snapshot.bottles[0], quantity: 7 }] };
    await a.save(remote);
    await b.save(local);
    await syncOnce(a, session, config);
    const syncing = syncOnce(b, session, config);
    await asked;
    assert.deepEqual(seen, { local, remote });
    assert.deepEqual(await b.read(), local);
    assert.deepEqual(await a.read(), remote);
    const observer = await device(t);
    await syncOnce(observer, session, config);
    assert.deepEqual(await observer.read(), remote);
    answer(choice);
    await syncing;
    await syncOnce(a, session, config);
    assert.deepEqual(await a.read(), choice === 'local' ? local : remote);
    assert.deepEqual(await b.read(), choice === 'local' ? local : remote);
  });
}

test('erreur d’authentification à l’initialisation : fin sans perdre la cave', async t => {
  const store = await device(t);
  await store.save(snapshot);
  await assert.rejects(syncOnce(store, { ...session, token: 'invalid-token' }, options()), error => {
    assert.ok(isAuthenticationError(error));
    return true;
  });
  assert.deepEqual(await store.read(), snapshot);
});

test('jeton expiré : invitation à reconnecter, sans appel à Drive', async t => {
  const store = await device(t);
  await assert.rejects(syncOnce(store, { ...session, expiresAt: 0 }), /reconnectez/);
});

test('édition pendant un choix de conflit : une décision obsolète ne perd pas la nouvelle édition', async t => {
  const config = options();
  const a = await device(t);
  let answer;
  let notify;
  let calls = 0;
  const asked = new Promise(resolve => { notify = resolve; });
  const newer = { ...snapshot, lastModified: 400, bottles: [{ ...snapshot.bottles[0], quantity: 9 }] };
  const b = await device(t, input => {
    if (++calls === 1) {
      notify();
      return new Promise(resolve => { answer = resolve; });
    }
    assert.deepEqual(input.local, newer);
    return 'local';
  });
  await a.save(snapshot);
  await syncOnce(a, session, config);
  await syncOnce(b, session, config);
  await a.save({ ...snapshot, lastModified: 200 });
  await b.save({ ...snapshot, lastModified: 300 });
  await syncOnce(a, session, config);
  const syncing = syncOnce(b, session, config);
  await asked;
  await b.save(newer);
  answer('remote');
  await syncing;
  assert.deepEqual(await b.read(), newer);
  await syncOnce(a, session, config);
  assert.deepEqual(await a.read(), newer);
});

test('annuler un conflit préserve les deux caves et permet une nouvelle tentative', async t => {
  const config = options();
  const a = await device(t);
  let rejectChoice;
  let notify;
  let cancelled = false;
  const asked = new Promise(resolve => { notify = resolve; });
  const b = await device(t, () => {
    if (cancelled) return 'local';
    notify();
    return new Promise((_, reject) => { rejectChoice = reject; });
  });
  await a.save(snapshot);
  await syncOnce(a, session, config);
  await syncOnce(b, session, config);
  const remote = { ...snapshot, lastModified: 200 };
  const local = { ...snapshot, lastModified: 300 };
  await a.save(remote);
  await b.save(local);
  await syncOnce(a, session, config);
  const controller = new AbortController();
  const syncing = syncOnce(b, session, { ...config, signal: controller.signal });
  const rejected = assert.rejects(syncing, /annulée/);
  await asked;
  await assert.rejects(syncOnce(b, session, config), /déjà en cours/);
  controller.abort();
  rejectChoice(new Error('Choix annulé.'));
  await rejected;
  cancelled = true;
  assert.deepEqual(await b.read(), local);
  const observer = await device(t);
  await syncOnce(observer, session, config);
  assert.deepEqual(await observer.read(), remote);
  await syncOnce(b, session, config);
  assert.deepEqual(await b.read(), local);
});

test('401 pendant la réplication : arrêt des relances automatiques et nouvelle tentative possible', async t => {
  const store = await device(t);
  const config = options();
  await store.save(snapshot);
  await syncOnce(store, session, config);
  await store.save({ ...snapshot, lastModified: 999 });
  const originalFetch = globalThis.fetch;
  let deniedRequests = 0;
  globalThis.fetch = (url, init) => {
    if (String(url).includes('/upload/drive/v2/')) {
      deniedRequests++;
      return Promise.resolve(new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 }));
    }
    return originalFetch(url, init);
  };
  try {
    await assert.rejects(syncOnce(store, session, config), error => {
      assert.ok(isAuthenticationError(error));
      // The core preserves RxErrors on push, but wraps them on pull.
      assert.match(error.code, /^(RC_PULL|RC_PUSH|FETCH)$/);
      return true;
    });
    // Pull and push can already have started together. They may both finish
    // after cancellation, but neither must enter an automatic retry cycle.
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.ok(deniedRequests <= 2);
    const count = deniedRequests;
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(deniedRequests, count);
  } finally {
    globalThis.fetch = originalFetch;
  }
  await syncOnce(store, session, config);
  assert.equal((await store.read()).lastModified, 999);
});

test('classification d’authentification structurée, sans faux positif sur les données ou quotas', () => {
  assert.equal(isAuthenticationError({ parameters: { errors: [{ parameters: { status: 401 } }] } }), true);
  assert.equal(isAuthenticationError({ parameters: { status: 403,
    errorText: JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } }) } }), true);
  assert.equal(isAuthenticationError({ parameters: { status: 403,
    errorText: JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }) } }), false);
  assert.equal(isAuthenticationError({ parameters: { status: 500,
    pushRows: [{ content: 'Vin 401, millésime 1403', lastModified: 401403 }] } }), false);
});
