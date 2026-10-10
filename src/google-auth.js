const SCOPE = 'openid https://www.googleapis.com/auth/drive.appdata';
let loading;

export function loadGoogleIdentity() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        script.remove();
        loading = undefined;
        reject(new Error('Google est inaccessible. Vérifiez la connexion puis réessayez.'));
      };
      document.head.appendChild(script);
    });
  }
  return loading;
}

export function requestGoogleToken(clientId) {
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      include_granted_scopes: false,
      callback: async response => {
        try {
          if (response.error || !response.access_token ||
              !google.accounts.oauth2.hasGrantedAllScopes(response,
                'openid', 'https://www.googleapis.com/auth/drive.appdata')) {
            throw new Error('Autorisation Google Drive refusée ou incomplète.');
          }
          const identity = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${response.access_token}` },
            cache: 'no-store'
          });
          if (!identity.ok) throw new Error('Impossible de vérifier le compte Google. Reconnectez-vous.');
          const { sub } = await identity.json();
          if (!sub) throw new Error('Compte Google non identifié.');
          const expiresIn = Number(response.expires_in);
          if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Jeton Google expiré. Reconnectez-vous.');
          resolve({
            token: response.access_token,
            accountId: sub,
            expiresAt: Date.now() + expiresIn * 1000
          });
        } catch (error) {
          reject(error);
        }
      },
      error_callback: () => reject(new Error('Connexion Google annulée. Réessayez pour vous connecter.'))
    });
    // Called directly from the click handler, after the SDK was loaded.
    client.requestAccessToken({ prompt: 'select_account' });
  });
}

export function revokeGoogleToken(token) {
  globalThis.google?.accounts?.oauth2.revoke(token, () => {});
}
