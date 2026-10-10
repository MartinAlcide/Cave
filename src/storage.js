import { createRxDatabase } from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';

const schema = (properties) => ({
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: { id: { type: 'string', maxLength: 100 }, ...properties },
  required: ['id', ...Object.keys(properties)],
  additionalProperties: false
});

export function parseCave(content) {
  const data = JSON.parse(content);
  if (!data || !Array.isArray(data.bottles) ||
      !data.bottles.every(b => b && typeof b.id === 'string' &&
        typeof b.color === 'string' && typeof b.quantity === 'number' &&
        typeof b.format === 'number') ||
      !(data.lastModified == null || typeof data.lastModified === 'number')) {
    throw new Error('Données de cave invalides. La copie d’origine est conservée.');
  }
  return { ...data, lastModified: data.lastModified ?? null };
}

// Duplicate inserts can occur when two tabs perform the first migration together.
async function insertOnce(collection, data) {
  const result = await collection.bulkInsert([data]);
  const error = result.error.find(error => error.status !== 409);
  if (error) throw error;
}

export async function openCave({
  name = 'cave-rxdb-v1',
  legacyStorage = globalThis.localStorage,
  dexieSettings,
  multiInstance = true,
  chooseConflict = async () => { throw new Error('Choix de conflit indisponible.'); }
} = {}) {
  const db = await createRxDatabase({
    name,
    storage: wrappedValidateAjvStorage({ storage: getRxStorageDexie(dexieSettings) }),
    multiInstance
  });
  try {
    await db.addCollections({
      cave: {
        // Keep the existing snapshot format. Only this collection is replicated.
        schema: schema({ content: { type: 'string' } }),
        conflictHandler: {
          isEqual: (a, b) => a.content === b.content && a._deleted === b._deleted,
          resolve: async ({ newDocumentState, realMasterState }) => {
            const choice = await chooseConflict({
              local: parseCave(newDocumentState.content),
              remote: parseCave(realMasterState.content)
            });
            if (choice !== 'local' && choice !== 'remote') {
              throw new Error('Un choix explicite est requis.');
            }
            return choice === 'local' ? newDocumentState : realMasterState;
          }
        }
      },
      migration: {
        schema: schema({ original: { type: ['string', 'null'] } })
      },
      settings: {
        schema: schema({ value: { type: 'string' } })
      }
    });
    const { cave, migration } = db.collections;
    if (!await migration.findOne('localstorage-v1').exec()) {
      const original = legacyStorage.getItem('cave-v1');
      if (original !== null && !await cave.findOne('cave').exec()) {
        const data = parseCave(original);
        await insertOnce(cave, { id: 'cave', content: JSON.stringify(data) });
      }
      // A durable marker plus an exact backup, never sent to Drive.
      // localStorage['cave-v1'] is also left untouched.
      await insertOnce(migration, { id: 'localstorage-v1', original });
    }
    const readDocument = doc => doc
      ? parseCave(doc.content)
      : { bottles: [], lastModified: null };
    let writes = Promise.resolve();
    return {
      db,
      collection: cave,
      read: async () => readDocument(await cave.findOne('cave').exec()),
      subscribe: listener => cave.findOne('cave').$.subscribe(doc => listener(readDocument(doc))),
      save(data, base) {
        const content = JSON.stringify(data);
        parseCave(content);
        const write = writes.then(async () => {
          let doc = await cave.findOne('cave').exec();
          if (!doc) {
            await insertOnce(cave, { id: 'cave', content });
            doc = await cave.findOne('cave').exec();
          }
          return doc.incrementalModify(async current => {
            const remote = parseCave(current.content);
            if (base && current.content !== content &&
                (JSON.stringify(remote.bottles) !== JSON.stringify(base.bottles) ||
                 remote.lastModified !== base.lastModified)) {
              // Another tab or a pull changed the snapshot since the UI read it.
              // RxDB retries this modifier if it changes again during the choice.
              const choice = await chooseConflict({ local: data, remote, source: 'local' });
              if (choice === 'remote') return current;
              if (choice !== 'local') throw new Error('Un choix explicite est requis.');
            }
            return { ...current, content };
          });
        });
        writes = write.catch(() => {});
        return write;
      },
      flush: () => writes,
      async bindAccount(accountId) {
        await insertOnce(db.settings, { id: 'google-account', value: accountId });
        const account = await db.settings.findOne('google-account').exec();
        if (account.value !== accountId) {
          throw new Error('Cette cave est liée à un autre compte Google. Reconnectez-vous avec ce compte.');
        }
      },
      close: () => db.close()
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
