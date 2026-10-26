'use strict';

// GitHub App authentication for the runner: the JWT signed with the App's
// private key, the installation that serves one repository owner, and the two
// access tokens a request mints. The runner's token carries the installation's
// own permissions (it clones, fetches and pushes) and is cached until five
// minutes before it expires; the agent's is minted read-only on the request's
// repository alone, once per run, and is never the runner's. The App's
// credentials sign and never travel: the JWT is an assertion, the private key
// reaches no header, no command line and no log.
//
// There is no configuration for the API's base URL: production talks to
// https://api.github.com and the tests hand the provider a local stand-in
// through the same constructor.

const crypto = require('node:crypto');

const DEFAULT_API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 30_000;
// A token is taken again when less than this remains, so a call that starts
// now is never still running when the token it used expires.
const TOKEN_MARGIN_MS = 25 * 60_000;
const TOKEN_LIFETIME_MS = 60 * 60_000;
// The JWT is valid for nine minutes and issued a minute back, inside GitHub's
// ten minute ceiling and ahead of any clock skew.
const JWT_ISSUED_BEHIND_SECONDS = 60;
const JWT_EXPIRY_AHEAD_SECONDS = 540;
// The cache key for a request that names no repository: served by the App's
// first installation by id.
const ESTATE_KEY = '_estate';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function buildGitHubJwt(appId, privateKey, nowMs) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const issuedAt = Math.floor(nowMs / 1000);
  const claims = base64url(JSON.stringify({
    iat: issuedAt - JWT_ISSUED_BEHIND_SECONDS,
    exp: issuedAt + JWT_EXPIRY_AHEAD_SECONDS,
    iss: appId,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(privateKey))}`;
}

function createProvider({ appId, privateKey, baseUrl = DEFAULT_API_BASE, now = Date.now, timeoutMs = REQUEST_TIMEOUT_MS, log = () => {} }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  // One installation lookup per owner, and one cached runner token per
  // installation. The agent's token is never cached: it is minted at spawn
  // time and dies with the run that asked for it.
  const installations = new Map();
  const runnerTokens = new Map();

  async function apiCall(method, path, body) {
    const jwt = buildGitHubJwt(appId, privateKey, now());
    const controller = new AbortController();
    const bound = setTimeout(() => controller.abort(), timeoutMs);
    let response = null;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      const why = error.name === 'AbortError' ? `no answer within ${Math.round(timeoutMs / 1000)} seconds` : error.message;
      throw new Error(`the GitHub API call ${method} ${path} could not be made: ${why}`);
    } finally {
      clearTimeout(bound);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(`the GitHub API call ${method} ${path} was refused: ${response.status} ${(payload && payload.message) || 'no message'}`);
    }
    return payload;
  }

  // The installation for the repository's own owner: looked up by owner and
  // cached, and never accepted when the account GitHub names is another one,
  // because a token minted on it would reach that account's repositories.
  async function installationId(owner, repo) {
    if (owner === null || owner === undefined) {
      if (installations.has(ESTATE_KEY)) return installations.get(ESTATE_KEY);
      const list = [];
      for (let page = 1; page <= 10; page += 1) {
        const batch = (await apiCall('GET', `/app/installations?per_page=100&page=${page}`)) || [];
        list.push(...batch);
        if (batch.length < 100) break;
      }
      const sorted = [...list].sort((a, b) => a.id - b.id);
      const first = sorted[0];
      if (!first) throw new Error('the GitHub App has no installation, so no token can be minted for a request that names no repository');
      installations.set(ESTATE_KEY, first.id);
      log('info', `installation ${first.id} (${first.account ? first.account.login : 'unknown'}) serves the estate for requests that name no repository`);
      return first.id;
    }
    const key = String(owner).toLowerCase();
    if (installations.has(key)) return installations.get(key);
    const found = await apiCall('GET', `/repos/${owner}/${repo}/installation`);
    const login = found && found.account && found.account.login;
    if (String(login || '').toLowerCase() !== key) {
      throw new Error(`the installation GitHub answered for ${owner}/${repo} belongs to ${login || 'no account'}, not ${owner}, so no token was minted`);
    }
    installations.set(key, found.id);
    return found.id;
  }

  async function runnerToken(owner, repo) {
    const id = await installationId(owner, repo);
    const cached = runnerTokens.get(id);
    if (cached && cached.expiresAtMs - TOKEN_MARGIN_MS > now()) return cached.token;
    const minted = await apiCall('POST', `/app/installations/${id}/access_tokens`);
    const expiresAtMs = Number.isFinite(Date.parse(minted.expires_at)) ? Date.parse(minted.expires_at) : now() + TOKEN_LIFETIME_MS;
    runnerTokens.set(id, { token: minted.token, expiresAtMs });
    return minted.token;
  }

  async function agentToken(owner, repo) {
    const id = await installationId(owner, repo);
    const body = { permissions: { contents: 'read' } };
    if (repo) body.repositories = [repo];
    const minted = await apiCall('POST', `/app/installations/${id}/access_tokens`, body);
    return minted.token;
  }

  return { appId, privateKey, runnerToken, agentToken };
}

module.exports = { DEFAULT_API_BASE, buildGitHubJwt, createProvider };
