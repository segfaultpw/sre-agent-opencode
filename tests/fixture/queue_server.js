#!/usr/bin/env node
'use strict';

// Stands in for the SRE Agent platform while it is being built: the queue, the
// brief and the report, with the two credentials kept apart the way the real
// endpoints keep them. Every request is appended to FIXTURE_LOG as one JSON
// object, including the Authorization header it arrived with, so a test can
// assert which credential reached which call rather than trusting the runner
// to say.
//
// Configured entirely by environment, so a bash test can drive it:
//   FIXTURE_PORT_FILE      where to write the port once listening
//   FIXTURE_LOG            the request log
//   FIXTURE_API_KEY        the key the queue accepts
//   FIXTURE_HANDOFF_TOKEN  the credential the brief and the report accept
//   FIXTURE_QUEUE_FILE     a JSON array of jobs, served once
//   FIXTURE_QUEUE_STATUSES a comma separated list of statuses to answer the
//                          queue with in order; the last one repeats
//   FIXTURE_BRIEF_FILE     the brief the brief endpoint serves

const fs = require('node:fs');
const http = require('node:http');

const logPath = process.env.FIXTURE_LOG;
const portFile = process.env.FIXTURE_PORT_FILE;
const apiKey = process.env.FIXTURE_API_KEY || '';
const handoffToken = process.env.FIXTURE_HANDOFF_TOKEN || '';
const statuses = (process.env.FIXTURE_QUEUE_STATUSES || '200').split(',').map((value) => Number.parseInt(value, 10));
const briefFile = process.env.FIXTURE_BRIEF_FILE || '';

let queueCalls = 0;
let queueServed = false;

function record(entry) {
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

// Served once. A job the runner already collected must not be handed to it
// again on the next poll of the same case.
function readQueue() {
  const file = process.env.FIXTURE_QUEUE_FILE;
  if (queueServed || !file || !fs.existsSync(file)) return [];
  queueServed = true;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function send(response, status, contentType, body) {
  response.writeHead(status, { 'Content-Type': contentType });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const authorization = request.headers.authorization || '';
    const url = new URL(request.url, 'http://127.0.0.1');
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    record({ method: request.method, path: url.pathname, authorization, body });

    if (url.pathname === '/api/fix-runner/queue') {
      const status = statuses[Math.min(queueCalls, statuses.length - 1)];
      queueCalls += 1;
      if (status !== 200) {
        // FIXTURE_QUEUE_CODE is the stable code the platform sends with a
        // refusal, and it is how the runner tells an operator switching this
        // runner off from a key that is wrong.
        const code = process.env.FIXTURE_QUEUE_CODE || '';
        send(response, status, 'application/json', JSON.stringify(code ? { error: { code } } : { error: 'fixture' }));
        return;
      }
      if (authorization !== `Bearer ${apiKey}`) {
        send(response, 401, 'application/json', JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      send(response, 200, 'application/json', JSON.stringify({ data: readQueue() }));
      return;
    }

    // The real endpoints answer one indistinguishable 404 for every auth
    // failure, so the fixture does too: a runner that passed the wrong
    // credential must not be able to tell what went wrong from the status.
    if (authorization !== `Bearer ${handoffToken}`) {
      send(response, 404, 'application/json', JSON.stringify({ error: 'not found' }));
      return;
    }

    if (request.method === 'GET' && url.pathname.endsWith('/brief')) {
      send(response, 200, 'text/markdown', briefFile ? fs.readFileSync(briefFile, 'utf8') : 'no brief');
      return;
    }

    if (request.method === 'POST' && url.pathname.endsWith('/report')) {
      send(response, 201, 'application/json', JSON.stringify({ data: { status: 'reported' } }));
      return;
    }

    send(response, 404, 'application/json', JSON.stringify({ error: 'not found' }));
  });
});

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
