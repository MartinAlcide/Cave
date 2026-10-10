import { loadGoogleIdentity, requestGoogleToken, revokeGoogleToken } from './google-auth.js';
import { syncOnce, isAuthenticationError } from './drive.js';
export { openCave } from './storage.js';

const { createElement: h, useState, useEffect, useRef } = globalThis.React;
const clientId = GOOGLE_CLIENT_ID;
const buttonStyle = { color: '#6B1E32', border: '1px solid #DDD4C4', padding: '5px 9px' };

export function createConflictPrompt() {
  let listener = () => {};
  const pending = [];
  return {
    subscribe(next) { listener = next; return () => { listener = () => {}; }; },
    choose(input) {
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject, input });
        if (pending.length === 1) listener(input);
      });
    },
    answer(choice) {
      pending.shift()?.resolve(choice);
      listener(pending[0]?.input || null);
    },
    cancel() {
      pending.splice(0).forEach(prompt => prompt.reject(new Error('Synchronisation annulée. Les versions sont conservées.')));
      listener(null);
    }
  };
}

function Version({ title, data }) {
  return h('details', { style: { marginTop: 8 } },
    h('summary', null, `${title} : ${data.bottles.reduce((sum, b) => sum + b.quantity, 0)} bouteilles`,
      data.lastModified ? ` (${new Date(data.lastModified).toLocaleString('fr-FR')})` : ''),
    h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto', fontSize: 12 } },
      JSON.stringify(data.bottles, null, 2)));
}

export function DriveControls({ store, conflicts, storageError }) {
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sdkReady, setSdkReady] = useState(false);
  const [status, setStatus] = useState(clientId ? 'Google Drive déconnecté.' : 'Google Drive non configuré.');
  const [conflict, setConflict] = useState(null);
  const controller = useRef(null);
  const connected = session && session.expiresAt > Date.now();

  useEffect(() => conflicts.subscribe(setConflict), [conflicts]);
  useEffect(() => {
    if (clientId) loadGoogleIdentity().then(() => setSdkReady(true)).catch(error => setStatus(error.message));
  }, []);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => {
      setSession(null);
      setStatus('Jeton expiré. Reconnectez-vous à Google Drive.');
      controller.current?.abort();
      conflicts.cancel();
    }, Math.max(0, session.expiresAt - Date.now() - 30_000));
    return () => clearTimeout(timer);
  }, [session, conflicts]);

  function connect() {
    if (!sdkReady) {
      setStatus('Chargement de Google…');
      loadGoogleIdentity().then(() => {
        setSdkReady(true);
        setStatus('Google prêt. Cliquez sur Connecter Google Drive.');
      }).catch(error => setStatus(error.message));
      return;
    }
    setBusy(true);
    setStatus('Connexion à Google…');
    // Do not await before requesting the popup: Safari requires the user gesture.
    requestGoogleToken(clientId).then(async next => {
      await store.bindAccount(next.accountId);
      setSession(next);
      setStatus('Google Drive connecté. Synchronisation à la demande.');
    }).catch(error => setStatus(error.message)).finally(() => setBusy(false));
  }

  async function synchronize() {
    if (!connected || session.expiresAt <= Date.now() + 30_000) {
      setSession(null);
      setStatus('Jeton expiré. Reconnectez-vous à Google Drive.');
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setStatus('Synchronisation… Vous pouvez continuer à modifier la cave.');
    try {
      await syncOnce(store, { ...session, clientId }, { signal: abort.signal });
      setStatus(`Synchronisé à ${new Date().toLocaleTimeString('fr-FR')}.`);
    } catch (error) {
      if (isAuthenticationError(error)) {
        setSession(null);
        setStatus('Jeton expiré ou révoqué. Reconnectez-vous à Google Drive.');
      } else {
        setStatus(abort.signal.aborted ? 'Synchronisation arrêtée. Reconnectez-vous si le jeton a expiré.' :
          'Synchronisation interrompue. Les données locales sont conservées. Réessayez avec Synchroniser.');
      }
    } finally {
      conflicts.cancel();
      controller.current = null;
      setBusy(false);
    }
  }

  function disconnect() {
    controller.current?.abort();
    conflicts.cancel();
    if (session) revokeGoogleToken(session.token);
    setSession(null);
    setStatus('Google Drive déconnecté. La cave locale est conservée.');
  }

  return h('section', { 'aria-label': 'Synchronisation Google Drive', style: { marginTop: 18, fontSize: 13 } },
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
      h('button', { onClick: connect, disabled: !clientId || busy, style: buttonStyle }, 'Connecter Google Drive'),
      h('button', { onClick: synchronize, disabled: !connected || busy || storageError, style: buttonStyle }, 'Synchroniser'),
      h('button', { onClick: disconnect, disabled: (busy || !session) && !controller.current, style: buttonStyle }, 'Déconnecter')),
    h('p', { role: 'status', style: { color: '#8C8073', marginTop: 6 } }, status),
    conflict && h('div', { role: 'region', 'aria-label': 'Conflit de synchronisation',
      style: { border: '1px solid #6B1E32', padding: 12, marginTop: 10 } },
      h('p', null, conflict.source === 'local' ?
        'La cave locale a changé depuis cette édition. Choisissez la cave entière à conserver avant tout écrasement.' :
        'Les deux caves ont changé. Choisissez la cave entière à conserver avant tout écrasement.'),
      h(Version, { title: 'Version locale', data: conflict.local }),
      h(Version, { title: conflict.source === 'local' ? 'Version actuellement enregistrée' : 'Version distante', data: conflict.remote }),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 } },
        h('button', { onClick: () => conflicts.answer('local'), style: buttonStyle }, 'Garder la version locale'),
        h('button', { onClick: () => conflicts.answer('remote'), style: buttonStyle },
          conflict.source === 'local' ? 'Garder la version enregistrée' : 'Garder la version distante'),
        h('button', { onClick: disconnect, style: buttonStyle }, 'Annuler et déconnecter'))));
}
