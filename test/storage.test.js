import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openCave } from '../src/storage.js';

export const bottle = { id: 'wine-1', color: 'rouge', pays: 'France', region: 'Bourgogne',
  appellation: 'Volnay', domaine: 'Domaine test', cuvee: '', millesime: '2020',
  quantity: 3, format: 75, location: 'Casier A' };
export const snapshot = { bottles: [bottle], lastModified: 123456789 };
const name = () => `cave-test-${crypto.randomUUID()}`;

test('migre une seule fois, conserve exactement l’original et persiste après réouverture', async () => {
  const original = JSON.stringify(snapshot, null, 2);
  const legacy = { getItem: () => original };
  const dbName = name();
  let store = await openCave({ name: dbName, legacyStorage: legacy, multiInstance: false });
  assert.deepEqual(await store.read(), snapshot);
  assert.equal((await store.db.migration.findOne('localstorage-v1').exec()).original, original);
  const changed = { bottles: [], lastModified: 999 };
  await store.save(changed);
  await store.close();
  store = await openCave({ name: dbName, legacyStorage: {
    getItem() { throw new Error('la migration ne doit plus lire localStorage'); }
  }, multiInstance: false });
  assert.deepEqual(await store.read(), changed);
  assert.equal(legacy.getItem('cave-v1'), original);
  await store.close();
});

test('ne crée pas de document vide à pousser et ne remigre pas un ancien localStorage tardif', async () => {
  const dbName = name();
  let store = await openCave({ name: dbName, legacyStorage: { getItem: () => null }, multiInstance: false });
  assert.equal(await store.collection.findOne('cave').exec(), null);
  await store.close();
  store = await openCave({ name: dbName, legacyStorage: { getItem: () => JSON.stringify(snapshot) }, multiInstance: false });
  assert.deepEqual(await store.read(), { bottles: [], lastModified: null });
  await store.close();
});

test('refuse une migration malformée sans marquer la migration comme terminée', async () => {
  const dbName = name();
  const original = '{broken';
  await assert.rejects(openCave({ name: dbName, legacyStorage: { getItem: () => original }, multiInstance: false }));
  const store = await openCave({ name: dbName, legacyStorage: { getItem: () => JSON.stringify(snapshot) }, multiInstance: false });
  assert.deepEqual(await store.read(), snapshot);
  await store.close();
});

test('les écritures locales ne font aucun appel réseau et conservent leur ordre', async () => {
  const store = await openCave({ name: name(), legacyStorage: { getItem: () => null }, multiInstance: false });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('le réseau est interdit'); };
  try {
    await Promise.all([store.save(snapshot), store.save({ ...snapshot, lastModified: 999 })]);
    assert.equal((await store.read()).lastModified, 999);
  } finally {
    globalThis.fetch = originalFetch;
    await store.close();
  }
});

test('refuse de mélanger les comptes Google pour une même cave locale', async () => {
  const store = await openCave({ name: name(), legacyStorage: { getItem: () => null }, multiInstance: false });
  await store.bindAccount('account-a');
  await store.bindAccount('account-a');
  await assert.rejects(store.bindAccount('account-b'), /autre compte/);
  await store.close();
});

for (const choice of ['local', 'remote']) {
  test(`une sauvegarde locale obsolète demande le choix ${choice} avant écrasement`, async () => {
    let answer;
    let notify;
    const asked = new Promise(resolve => { notify = resolve; });
    const store = await openCave({ name: name(), legacyStorage: { getItem: () => null }, multiInstance: false,
      chooseConflict: () => {
        notify();
        return new Promise(resolve => { answer = resolve; });
      } });
    await store.save(snapshot);
    const base = await store.read();
    const remote = { ...snapshot, lastModified: 200 };
    const local = { ...snapshot, lastModified: 300 };
    await store.save(remote);
    const saving = store.save(local, base);
    await asked;
    assert.deepEqual(await store.read(), remote);
    answer(choice);
    await saving;
    assert.deepEqual(await store.read(), choice === 'local' ? local : remote);
    await store.close();
  });
}
