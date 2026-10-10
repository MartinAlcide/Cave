import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestGoogleToken } from '../src/google-auth.js';

function mockGoogle(t, response, granted = true) {
  const previous = { google: globalThis.google, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, previous));
  globalThis.google = { accounts: { oauth2: {
    hasGrantedAllScopes: () => granted,
    initTokenClient: options => ({ requestAccessToken(request) {
      assert.equal(options.client_id, 'test-client');
      assert.ok(options.scope.includes('drive.appdata'));
      assert.equal(request.prompt, 'select_account');
      queueMicrotask(() => response === 'popup_closed' ? options.error_callback() : options.callback(response));
    } })
  } } };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://www.googleapis.com/oauth2/v3/userinfo');
    assert.equal(options.headers.Authorization, 'Bearer memory-only-token');
    return new Response(JSON.stringify({ sub: 'account-a' }), { status: 200 });
  };
}

test('GIS demande appData et openid, identifie le compte et retourne un jeton temporaire en mémoire', async t => {
  mockGoogle(t, { access_token: 'memory-only-token', expires_in: 3600 });
  const session = await requestGoogleToken('test-client');
  assert.equal(session.accountId, 'account-a');
  assert.equal(session.token, 'memory-only-token');
  assert.ok(session.expiresAt > Date.now() + 3_500_000);
});

test('GIS refuse une autorisation incomplète', async t => {
  mockGoogle(t, { access_token: 'memory-only-token', expires_in: 3600 }, false);
  await assert.rejects(requestGoogleToken('test-client'), /incomplète/);
});

test('GIS signale une popup fermée', async t => {
  mockGoogle(t, 'popup_closed');
  await assert.rejects(requestGoogleToken('test-client'), /annulée/);
});

test('GIS refuse un jeton dont la durée est invalide', async t => {
  mockGoogle(t, { access_token: 'memory-only-token', expires_in: 'invalid' });
  await assert.rejects(requestGoogleToken('test-client'), /expiré/);
});
