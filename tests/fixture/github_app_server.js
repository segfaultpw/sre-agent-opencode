#!/usr/bin/env node
'use strict';

// Stands in for the GitHub API while the runner is in App mode: the App's own
// installations, the installation for one repository, and the two access
// tokens a request mints (the runner's, with no body, and the agent's, with
// the read-only scope). Every request is appended to GITHUB_FIXTURE_LOG as one
// JSON object with the path, the Authorization header's JWT decoded to its
// claims (the signature is not checked here; tests/github_app_test.js checks
// it against a generated key), and the body, so a test can assert which scope
// each mint asked for rather than trusting the runner to say.
//
// Configured entirely by environment, so a bash test can drive it:
//   GITHUB_FIXTURE_PORT_FILE        where to write the port once listening
//   GITHUB_FIXTURE_LOG              the request log
//   GITHUB_FIXTURE_APP_ID           the App id the JWT's iss must carry
//   GITHUB_FIXTURE_OWNER            the owner the App is installed for (acme)
//   GITHUB_FIXTURE_INSTALLATION_ID  that installation's id (501)
//   GITHUB_FIXTURE_INSTALL_STATUS   a status other than 200 for the
//                                   repository installation lookup
//   GITHUB_FIXTURE_MINT_STATUS      a status other than 200 for the mints
//
// The agent's token is told from the runner's by the request's body: one with
// permissions is the agent's and answers ghs_agent-..., one without is the
// runner's and answers ghs_runner-....

const fs = require('node:fs');
const http = require('node:http');

const logPath = process.env.GITHUB_FIXTURE_LOG;
const portFile = process.env.GITHUB_FIXTURE_PORT_FILE;
const appId = process.env.GITHUB_FIXTURE_APP_ID || '123456';
const owner = process.env.GITHUB_FIXTURE_OWNER || 'acme';
const installationId = Number.parseInt(process.env.GITHUB_FIXTURE_INSTALLATION_ID || '501', 10);
const installStatus = Number.parseInt(process.env.GITHUB_FIXTURE_INSTALL_STATUS || '200', 10);
const mintStatus = Number.parseInt(process.env.GITHUB_FIXTURE_MINT_STATUS || '200', 10);

function record(entry) {
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

// The claims of the JWT the runner signed, without checking the signature:
// the fixture's job is to say what reached the API, and iss is the one claim
// a wrong App id would break.
function claimsOf(authorization) {
  const token = authorization.replace(/^Bearer\s+/i, '');
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(request.url, 'http://127.0.0.1');
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const claims = claimsOf(request.headers.authorization || '');
    record({ method: request.method, path: url.pathname, authorization: request.headers.authorization || '', claims, body });

    // Every call the runner makes carries the App's JWT or a minted token; a
    // request with neither, or a JWT whose iss is not this App, is refused the
    // way GitHub refuses one.
    if (!claims || String(claims.iss) !== appId) {
      send(response, 401, { message: 'Bad credentials' });
      return;
    }

    const installMatch = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url.pathname);
    if (request.method === 'GET' && installMatch) {
      // The installation is answered for the repository's own owner alone: an
      // owner the App is not installed for gets GitHub's 404, and a mismatched
      // account login is never handed out as if it were the owner's.
      if (installStatus !== 200) {
        send(response, installStatus, { message: 'Not Found' });
        return;
      }
      if (installMatch[1].toLowerCase() !== owner.toLowerCase()) {
        send(response, 404, { message: 'Not Found' });
        return;
      }
      send(response, 200, { id: installationId, account: { login: owner } });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/app/installations') {
      // Deliberately not sorted by id: the runner must pick the first by id,
      // not the first in the answer.
      send(response, 200, [
        { id: 9002, account: { login: 'zeta' } },
        { id: installationId, account: { login: owner } },
      ]);
      return;
    }

    const mintMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (request.method === 'POST' && mintMatch) {
      if (mintStatus !== 200) {
        send(response, mintStatus, { message: 'Bad credentials' });
        return;
      }
      if (Number.parseInt(mintMatch[1], 10) !== installationId) {
        send(response, 404, { message: 'Not Found' });
        return;
      }
      const scoped = Boolean(body && body.permissions);
      send(response, 201, {
        token: scoped ? 'ghs_agent-app-mode-fixture-token' : 'ghs_runner-app-mode-fixture-token',
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
      return;
    }

    send(response, 404, { message: 'Not Found' });
  });
});

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
