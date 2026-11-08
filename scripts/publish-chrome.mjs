// Uploads a new version of the extension to the Chrome Web Store and submits it for review.
//   node scripts/publish-chrome.mjs spoolrss-extension.zip
// Environment (GitHub secrets in CI):
//   CWS_SERVICE_ACCOUNT  the Google service account's JSON key (the whole file's contents)
//   CWS_PUBLISHER_ID     Developer Dashboard -> Publisher -> Settings
//   CWS_EXTENSION_ID     the item's ID, shown in the dashboard after the first (manual) upload
// Uses Chrome Web Store API v2: https://developer.chrome.com/docs/webstore/using-api

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.CWS_API_BASE || 'https://chromewebstore.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

const b64url = (data) => Buffer.from(data).toString('base64url');

/** Exchange a service account key for an access token (OAuth 2.0 JWT bearer grant). */
export async function accessToken(serviceAccount) {
  const tokenUri = serviceAccount.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: serviceAccount.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(serviceAccount.private_key, 'base64url');
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Getting an access token failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
  return body.access_token;
}

async function call(method, url, token, body, contentType) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(contentType && { 'Content-Type': contentType }) },
    body,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${url} failed (HTTP ${res.status}): ${text}`);
  return json;
}

export async function publish({ zipPath, serviceAccount, publisherId, extensionId, pollMs = 5000, maxPolls = 60 }) {
  const token = await accessToken(serviceAccount);
  const item = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}`;

  const upload = await call('POST', `${API}/upload/v2/${item}:upload`, token, fs.readFileSync(zipPath), 'application/zip');
  // The docs name uploadState; fetchStatus may report it under lastAsyncUploadState.
  const stateOf = (r) => r.uploadState ?? r.lastAsyncUploadState;
  let state = stateOf(upload);
  console.log(`Upload: ${state ?? JSON.stringify(upload)}`);
  for (let i = 0; state === 'IN_PROGRESS' && i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    const status = await call('GET', `${API}/v2/${item}:fetchStatus`, token);
    state = stateOf(status) ?? state;
  }
  if (state === 'IN_PROGRESS' || state === 'FAILED' || state === 'NOT_FOUND') {
    throw new Error(`The Chrome Web Store did not accept the upload (state: ${state}). Response: ${JSON.stringify(upload)}`);
  }

  const result = await call('POST', `${API}/v2/${item}:publish`, token, '{}', 'application/json');
  console.log(`Submitted for review: ${JSON.stringify(result)}`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [zipPath] = process.argv.slice(2);
  const { CWS_SERVICE_ACCOUNT, CWS_PUBLISHER_ID, CWS_EXTENSION_ID } = process.env;
  if (!zipPath || !CWS_SERVICE_ACCOUNT || !CWS_PUBLISHER_ID || !CWS_EXTENSION_ID) {
    console.error('Usage: CWS_SERVICE_ACCOUNT=... CWS_PUBLISHER_ID=... CWS_EXTENSION_ID=... node scripts/publish-chrome.mjs <zip>');
    process.exit(2);
  }
  publish({ zipPath, serviceAccount: JSON.parse(CWS_SERVICE_ACCOUNT), publisherId: CWS_PUBLISHER_ID, extensionId: CWS_EXTENSION_ID })
    .catch((err) => { console.error(err.message); process.exit(1); });
}
