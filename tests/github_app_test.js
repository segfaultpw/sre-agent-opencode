'use strict';
// The GitHub App half of App mode (runner/github_app.js): the JWT signed with
// the App's private key, the installation looked up per repository owner and
// cached, the runner's access token minted with the installation's own
// permissions and re-minted as it expires, and the agent's minted read-only on
// the request's repository alone. Every case runs against a local HTTP server
// standing in for api.github.com, which records what reached it, so the
// assertions are on the calls rather than on what the provider says.
// Run with `node tests/github_app_test.js`.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { buildGitHubJwt, createProvider } = require(path.resolve(__dirname, '..', 'runner', 'github_app.js'));

const APP_ID = 123456;
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

// A stand-in for api.github.com with the answers one case at a time: what to
// answer the installation lookup (per owner), the installations list, and the
// mints; and a record of every request that reached it.
function githubStandIn() {
  const seen = [];
  const state = {
    installations: { acme: 501, other: 502 },
    accountLogins: {},
    installationsList: [{ id: 9002, account: { login: 'zeta' } }, { id: 501, account: { login: 'acme' } }],
    mintAnswer: { 501: { token: 'ghs_runner-501', expires_at: 'in-an-hour' }, 502: { token: 'ghs_runner-502', expires_at: 'in-an-hour' } },
    mintStatus: 200,
    installStatus: 200,
    hang: false,
  };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      seen.push({ method: request.method, path: request.url, authorization: request.headers.authorization || '', body });
      if (state.hang) return; // never answers; the client's bound is what is tested
      const sendJson = (status, payload) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      const install = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(request.url);
      if (request.method === 'GET' && install) {
        if (state.installStatus !== 200) return sendJson(state.installStatus, { message: 'Not Found' });
        const id = state.installations[install[1]];
        if (!id) return sendJson(404, { message: 'Not Found' });
        return sendJson(200, { id, account: { login: state.accountLogins[install[1]] || install[1] } });
      }
      const installList = request.method === 'GET' && /^\/app\/installations/.exec(request.url);
      if (installList) {
        // Page two is empty: a short page ends the runner's walk.
        const page = Number.parseInt(new URL(request.url, 'https://api.github.com').searchParams.get('page') || '1', 10);
        return sendJson(200, page > 1 ? [] : state.installationsList);
      }
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(request.url);
      if (request.method === 'POST' && mint) {
        if (state.mintStatus !== 200) return sendJson(state.mintStatus, { message: 'Bad credentials' });
        const answer = state.mintAnswer[Number.parseInt(mint[1], 10)];
        if (!answer) return sendJson(404, { message: 'Not Found' });
        const baseNow = state.clockNow ? state.clockNow() : Date.now();
        const expiresAt = answer.expires_at === 'in-an-hour' ? new Date(baseNow + 3600_000).toISOString() : answer.expires_at;
        const token = body && body.permissions ? answer.token.replace('runner', 'agent') : answer.token;
        return sendJson(201, { token, expires_at: expiresAt });
      }
      sendJson(404, { message: 'Not Found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, state, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function providerOver(standInOverrides) {
  const clock = { nowMs: 1_700_000_000_000 };
  const lines = [];
  return {
    clock,
    lines,
    make: (app) =>
      createProvider({
        appId: APP_ID,
        privateKey: PEM,
        baseUrl: app.base,
        now: () => clock.nowMs,
        timeoutMs: 5000,
        log: (level, message) => lines.push(`${level} ${message}`),
      }),
  };
}

function claimsOf(jwt) {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
}

(async () => {
  await check('the JWT is RS256 over the App id, issued a minute back and expiring inside ten', () => {
    const nowMs = 1_700_000_000_000;
    const jwt = buildGitHubJwt(APP_ID, PEM, nowMs);
    const [header, claims, signature] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')), { alg: 'RS256', typ: 'JWT' });
    const parsed = claimsOf(jwt);
    assert.equal(parsed.iss, APP_ID);
    assert.equal(parsed.iat, Math.floor(nowMs / 1000) - 60);
    assert.equal(parsed.exp, Math.floor(nowMs / 1000) + 540);
    const verified = crypto.verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'));
    assert.equal(verified, true, 'the signature verifies with the App public key');
  });

  await check('a key that cannot sign is an error, not a token', async () => {
    assert.throws(() => buildGitHubJwt(APP_ID, 'not a pem at all', Date.now()));
  });

  await check('the runner token is minted per owner, the installation cached, and the token reused inside its life', async () => {
    const app = await githubStandIn();
    const wrap = providerOver();
    const provider = wrap.make(app);
    const first = await provider.runnerToken('acme', 'app');
    const again = await provider.runnerToken('acme', 'app');
    const otherRepo = await provider.runnerToken('acme', 'other-repo');
    const otherOwner = await provider.runnerToken('other', 'thing');
    assert.equal(first, 'ghs_runner-501');
    assert.equal(again, first, 'a second call inside the hour reuses the cached token');
    assert.equal(otherRepo, first, 'another repository of the same owner reuses it too');
    assert.equal(otherOwner, 'ghs_runner-502');
    const lookups = app.seen.filter((r) => /\/installation$/.test(r.path));
    assert.equal(lookups.length, 2, 'the installation is looked up once per owner');
    const mints = app.seen.filter((r) => /access_tokens$/.test(r.path));
    assert.equal(mints.length, 2, 'one mint per installation');
    for (const call of app.seen) {
      assert.match(call.authorization, /^Bearer /);
      assert.equal(claimsOf(call.authorization).iss, APP_ID);
    }
    app.server.close();
  });

  await check('a token past its margin is re-minted', async () => {
    const app = await githubStandIn();
    const wrap = providerOver();
    app.state.clockNow = () => wrap.clock.nowMs;
    const provider = wrap.make(app);
    await provider.runnerToken('acme', 'app');
    app.state.mintAnswer[501] = { token: 'ghs_runner-501-second', expires_at: 'in-an-hour' };
    wrap.clock.nowMs += 36 * 60_000; // past expires_at minus the 25 minute margin (a minted token must outlive the push and the pull-request call, each bounded at ten minutes)
    const second = await provider.runnerToken('acme', 'app');
    assert.equal(second, 'ghs_runner-501-second', 'the second call mints again');
    assert.equal(app.seen.filter((r) => /access_tokens$/.test(r.path)).length, 2);
    app.server.close();
  });

  await check('the agent token is a separate mint, read-only and scoped to the repository', async () => {
    const app = await githubStandIn();
    const wrap = providerOver();
    const provider = wrap.make(app);
    const runnerToken = await provider.runnerToken('acme', 'app');
    const agentToken = await provider.agentToken('acme', 'app');
    assert.equal(agentToken, 'ghs_agent-501');
    assert.notEqual(agentToken, runnerToken);
    const mints = app.seen.filter((r) => /access_tokens$/.test(r.path));
    const agentMint = mints.find((r) => r.body && r.body.permissions);
    assert.deepEqual(agentMint.body, { permissions: { contents: 'read' }, repositories: ['app'] });
    const runnerMint = mints.find((r) => !r.body);
    assert.equal(runnerMint.body, null, 'the runner mint asks for the installation own permissions');
    app.server.close();
  });

  await check('a request naming no repository is served by the first installation by id, and the log names it', async () => {
    const app = await githubStandIn();
    const wrap = providerOver();
    const provider = wrap.make(app);
    const token = await provider.runnerToken(null, null);
    assert.equal(token, 'ghs_runner-501', 'the list is not sorted, so 501 and not 9002 is first by id');
    const agentToken = await provider.agentToken(null, null);
    assert.equal(agentToken, 'ghs_agent-501');
    const agentMint = app.seen.find((r) => /access_tokens$/.test(r.path) && r.body && r.body.permissions);
    assert.deepEqual(agentMint.body.permissions, { contents: 'read' });
    assert.equal(agentMint.body.repositories, undefined, 'no repository is named, so none is scoped');
    assert.ok(wrap.lines.some((line) => line.includes('installation 501') && line.includes('estate')), `the log names the installation: ${wrap.lines}`);
    app.server.close();
  });

  await check('a 404 on the installation lookup is an error carrying the status and the message', async () => {
    const app = await githubStandIn();
    const provider = providerOver().make(app);
    await assert.rejects(() => provider.runnerToken('not-installed', 'repo'), (error) => {
      assert.match(error.message, /404/);
      assert.match(error.message, /Not Found/);
      return true;
    });
    app.server.close();
  });

  await check('a 401 on the mint is an error carrying the status and the message', async () => {
    const app = await githubStandIn();
    const provider = providerOver().make(app);
    app.state.mintStatus = 401;
    await assert.rejects(() => provider.runnerToken('acme', 'app'), (error) => {
      assert.match(error.message, /401/);
      assert.match(error.message, /Bad credentials/);
      return true;
    });
    app.server.close();
  });

  await check('an installation answered for another account is refused, and nothing is minted', async () => {
    const app = await githubStandIn();
    const provider = providerOver().make(app);
    app.state.accountLogins.acme = 'someone-else';
    await assert.rejects(() => provider.runnerToken('acme', 'app'), (error) => {
      assert.match(error.message, /acme/);
      assert.match(error.message, /someone-else/);
      return true;
    });
    assert.equal(app.seen.filter((r) => /access_tokens$/.test(r.path)).length, 0);
    app.server.close();
  });

  await check('a server that never answers is cut off by the bound', async () => {
    const app = await githubStandIn();
    const provider = createProvider({
      appId: APP_ID,
      privateKey: PEM,
      baseUrl: app.base,
      now: Date.now,
      timeoutMs: 150,
      log: () => {},
    });
    app.state.hang = true;
    await assert.rejects(() => provider.runnerToken('acme', 'app'), (error) => {
      assert.match(error.message, /installation/i);
      return true;
    });
    app.server.close();
  });

  await check('a server that cannot be reached is an error, not a crash', async () => {
    const app = await githubStandIn();
    const address = app.server.address();
    await new Promise((resolve) => app.server.close(resolve));
    const provider = createProvider({ appId: APP_ID, privateKey: PEM, baseUrl: `http://127.0.0.1:${address.port}`, now: Date.now, timeoutMs: 1000, log: () => {} });
    await assert.rejects(() => provider.runnerToken('acme', 'app'));
  });

  console.log(failed === 0 ? 'github_app_test: all checks passed' : `github_app_test: ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
