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
//   FIXTURE_BRIEF_STATUS   a status other than 200 to answer the brief with, as a
//                          platform that failed to serve it would
//   FIXTURE_HEARTBEAT_SECONDS  when set, the queue's answer carries it as
//                          heartbeat_seconds, as a platform with heartbeats
//                          does; unset, the answer is an older platform's
//   FIXTURE_HEARTBEAT_ANSWERS  a comma separated list of answers to the
//                          heartbeat, in order, the last one repeating:
//                          continue, taken_over, time_limit, 404 (the handoff
//                          endpoints' own not found, which a replaced token
//                          gets), route404 (what a platform task without the
//                          heartbeat route answers), or another status such
//                          as 503 (default: continue). Each beat's
//                          answer is in its log entry, as `answer`.
//   FIXTURE_REPLACEMENT_FILE  a JSON array of {status, body} answers to the
//                          replacement call (POST /api/handoffs/<id>/replacement),
//                          in order, the last one repeating; without it the call
//                          is answered 404 like any route the fixture does not know
//   FIXTURE_BRIEF_DELAY_MS  how long to hold the brief's answer
//   FIXTURE_REPORT_DELAY_MS how long to hold the report's answer; the moment it
//                          is sent is logged as its own entry, `answered_at`
//   Every entry carries `at`, the milliseconds it arrived.
//   FIXTURE_HEARTBEAT_AFTER_FILE  when set, every beat is answered continue
//                          until this file exists, and the list above starts
//                          from there: a case can wait for its agent to start

const fs = require('node:fs');
const http = require('node:http');

const logPath = process.env.FIXTURE_LOG;
const portFile = process.env.FIXTURE_PORT_FILE;
const apiKey = process.env.FIXTURE_API_KEY || '';
const handoffToken = process.env.FIXTURE_HANDOFF_TOKEN || '';
const statuses = (process.env.FIXTURE_QUEUE_STATUSES || '200').split(',').map((value) => Number.parseInt(value, 10));
const briefFile = process.env.FIXTURE_BRIEF_FILE || '';
const briefStatus = Number.parseInt(process.env.FIXTURE_BRIEF_STATUS || '200', 10);
const heartbeatSeconds = process.env.FIXTURE_HEARTBEAT_SECONDS ? Number(process.env.FIXTURE_HEARTBEAT_SECONDS) : null;
const heartbeatAnswers = (process.env.FIXTURE_HEARTBEAT_ANSWERS || 'continue').split(',');
const heartbeatAfterFile = process.env.FIXTURE_HEARTBEAT_AFTER_FILE || '';
const briefDelayMs = Number.parseInt(process.env.FIXTURE_BRIEF_DELAY_MS || '0', 10);
const reportDelayMs = Number.parseInt(process.env.FIXTURE_REPORT_DELAY_MS || '0', 10);

let queueCalls = 0;
let queueServed = false;
let heartbeatCalls = 0;
let replacementCalls = 0;

function record(entry) {
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function nextHeartbeatAnswer() {
  if (heartbeatAfterFile && !fs.existsSync(heartbeatAfterFile)) return 'continue';
  const answer = heartbeatAnswers[Math.min(heartbeatCalls, heartbeatAnswers.length - 1)];
  heartbeatCalls += 1;
  return answer;
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
    const beat = request.method === 'POST' && url.pathname.endsWith('/heartbeat') && authorization === `Bearer ${handoffToken}`;
    const beatAnswer = beat ? nextHeartbeatAnswer() : undefined;
    record({ method: request.method, path: url.pathname, authorization, body, at: Date.now(), ...(beat ? { answer: beatAnswer } : {}) });

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
      const answer = { data: readQueue() };
      if (heartbeatSeconds !== null) answer.heartbeat_seconds = heartbeatSeconds;
      send(response, 200, 'application/json', JSON.stringify(answer));
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
      if (briefStatus !== 200) {
        send(response, briefStatus, 'application/json', JSON.stringify({ error: 'fixture' }));
        return;
      }
      const brief = briefFile ? fs.readFileSync(briefFile, 'utf8') : 'no brief';
      setTimeout(() => send(response, 200, 'text/markdown', brief), briefDelayMs);
      return;
    }

    if (beat) {
      const answer = beatAnswer;
      if (answer === 'continue') {
        send(response, 200, 'application/json', JSON.stringify({ continue: true, lease_seconds: 180 }));
      } else if (answer === 'taken_over' || answer === 'time_limit') {
        send(response, 200, 'application/json', JSON.stringify({ continue: false, reason: answer }));
      } else if (answer === '404') {
        send(response, 404, 'application/json', JSON.stringify({ error: 'not found' }));
      } else if (answer === 'route404') {
        send(response, 404, 'application/json', JSON.stringify({ errors: { detail: 'Not Found' } }));
      } else {
        send(response, Number.parseInt(answer, 10), 'application/json', JSON.stringify({ error: 'fixture' }));
      }
      return;
    }

    if (request.method === 'POST' && url.pathname.endsWith('/replacement') && process.env.FIXTURE_REPLACEMENT_FILE) {
      const answers = JSON.parse(fs.readFileSync(process.env.FIXTURE_REPLACEMENT_FILE, 'utf8'));
      const answer = answers[Math.min(replacementCalls, answers.length - 1)];
      replacementCalls += 1;
      send(response, answer.status, 'application/json', JSON.stringify(answer.body));
      return;
    }

    if (request.method === 'POST' && url.pathname.endsWith('/report')) {
      setTimeout(() => {
        send(response, 201, 'application/json', JSON.stringify({ data: { status: 'reported' } }));
        record({ method: 'ANSWERED', path: `${url.pathname}#answered`, answered_at: Date.now() });
      }, reportDelayMs);
      return;
    }

    send(response, 404, 'application/json', JSON.stringify({ error: 'not found' }));
  });
});

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
