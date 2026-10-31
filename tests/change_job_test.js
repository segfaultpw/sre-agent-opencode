'use strict';
// The pull request change job: how the runner reads the job's `change` object,
// builds the commit message, and asks SRE Agent for a replacement. The end to
// end behaviour (a real remote, real git, the stubs) is in tests/runner_test.sh;
// this file pins the pieces that are decided in the runner alone.
// Run with `node tests/change_job_test.js`.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { internals } = require(path.resolve(__dirname, '..', 'runner', 'runner.js'));

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

const TRAILER = 'SRE-Agent-Change: 11111111-2222-3333-4444-555555555555';
const COMMIT_BODY = `Asked for by Jane on acme/app#7.\n\n${TRAILER}`;
const SHA = 'a'.repeat(40);

function pushJob(change = {}) {
  return {
    handoff_id: 'h-1',
    kind: 'pr_change',
    token: 'sre-agent-handoff-token',
    change: {
      mode: 'push',
      repo_full_name: 'acme/app',
      number: 7,
      url: 'https://github.com/acme/app/pull/7',
      base_ref: 'main',
      commit_body: COMMIT_BODY,
      replaceable: false,
      replacement_url: 'http://127.0.0.1:1/api/handoffs/h-1/replacement',
      head_ref: 'feature/lb',
      head_sha: SHA,
      ...change,
    },
  };
}

function replaceJob(change = {}) {
  return pushJob({ mode: 'replace', head_ref: null, head_sha: undefined, start_sha: SHA, start_on: 'head', replaceable: true, ...change });
}

// A platform that answers the replacement route with a scripted list of
// {status, body}, the last one repeating, and records every request.
function platform(answers) {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: raw ? JSON.parse(raw) : null });
      const answer = answers[Math.min(seen.length - 1, answers.length - 1)];
      response.writeHead(answer.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ seen, url: `http://127.0.0.1:${server.address().port}/api/handoffs/h-1/replacement`, close: () => server.close() }));
  });
}

const REPLACE_ANSWER = {
  decision: 'replace',
  branch: 'sre-agent/manual_request-1a2b3c4d',
  base_ref: 'main',
  start_sha: SHA,
  closing: true,
  number: 7,
  title: 'fix: raise the connection pool ceiling',
  body: 'The body.\n',
  draft: false,
};

const REQUEST = {
  instance: 'alpha',
  commit_sha: 'b'.repeat(40),
  made_on: SHA,
  paths: ['README.md'],
  summary: 'Raised the pool.',
  analysis: 'Raised the pool ceiling.',
  reason: null,
};

async function main() {
  internals.setReplacementRetryMs(5);

  await check('a push job is read into its mode, repository, number, branch and trailer', () => {
    const change = internals.changeFromJob(pushJob());
    assert.equal(change.mode, 'push');
    assert.equal(change.repo.fullName, 'acme/app');
    assert.equal(change.number, 7);
    assert.equal(change.headRef, 'feature/lb');
    assert.equal(change.headSha, SHA);
    assert.equal(change.replaceable, false);
    assert.equal(change.trailer, TRAILER);
  });

  await check('a replace job is read into its start commit and where it starts from', () => {
    const change = internals.changeFromJob(replaceJob());
    assert.equal(change.mode, 'replace');
    assert.equal(change.startSha, SHA);
    assert.equal(change.startOn, 'head');
    assert.equal(change.baseRef, 'main');
    assert.equal(change.replaceable, true);
  });

  await check('a job with no change object, or one the runner cannot act on, is an error that names the change', () => {
    assert.throws(() => internals.changeFromJob({ handoff_id: 'h-1', kind: 'pr_change' }), /change/);
    assert.throws(() => internals.changeFromJob({ ...pushJob(), change: 'push' }), /change/);
    assert.throws(() => internals.changeFromJob(pushJob({ mode: 'sideways' })), /mode/);
    assert.throws(() => internals.changeFromJob(pushJob({ head_ref: null })), /head_ref/);
    assert.throws(() => internals.changeFromJob(pushJob({ head_ref: '-evil' })), /head_ref/);
    assert.throws(() => internals.changeFromJob(pushJob({ head_ref: 'a/../b' })), /head_ref/);
    assert.throws(() => internals.changeFromJob(pushJob({ number: 0 })), /number/);
    assert.throws(() => internals.changeFromJob(pushJob({ repo_full_name: 'acme' })), /acme/);
    assert.throws(() => internals.changeFromJob(pushJob({ commit_body: '' })), /commit_body/);
    assert.throws(() => internals.changeFromJob(pushJob({ replacement_url: 'ftp://x' })), /replacement_url/);
    assert.throws(() => internals.changeFromJob(replaceJob({ start_sha: 'abc' })), /start_sha/);
    assert.throws(() => internals.changeFromJob(replaceJob({ start_on: 'tree' })), /start_on/);
  });

  await check('a commit body without a trailer line reads no trailer', () => {
    assert.equal(internals.changeFromJob(pushJob({ commit_body: 'Asked for by Jane.' })).trailer, null);
  });

  await check('the commit message is the title, a blank line and the job\'s commit_body', () => {
    assert.equal(internals.changeCommitMessage('fix: raise the pool', COMMIT_BODY), `fix: raise the pool\n\n${COMMIT_BODY}`);
  });

  await check('the title is the model\'s valid Title line, else the agent\'s first line, at most 72 characters, else a change fallback naming the handoff', () => {
    const job = pushJob();
    assert.equal(internals.changeTitle(job, 'Title: feat(pool): raise the ceiling\n\nBody.').title, 'feat(pool): raise the ceiling');
    const long = internals.changeTitle(job, `${'Raised the connection pool ceiling so that the service stops refusing checkouts '.repeat(3)}`).title;
    assert.ok(Array.from(long).length <= 72, long);
    assert.match(long, /^fix: Raised the connection pool ceiling/);
    assert.equal(internals.changeTitle(job, '<!-- nothing to say -->').title, 'fix: apply the requested change (h-1)');
    assert.equal(internals.changeTitle(job, '').title, 'fix: apply the requested change (h-1)');
  });

  await check('a requested_title or title key on a change job is ignored: the change has no title of its own', () => {
    const job = { ...pushJob(), title: 'feat(job): from the platform', requested_title: 'feat(req): from a person' };
    assert.equal(internals.changeTitle(job, 'Raised the pool.').title, 'fix: Raised the pool.');
  });

  await check('askReplacement posts the body with the handoff token and answers the parsed decision', async () => {
    const server = await platform([{ status: 200, body: REPLACE_ANSWER }]);
    try {
      const job = pushJob({ replacement_url: server.url });
      const answer = await internals.askReplacement({}, job, REQUEST, null);
      assert.deepEqual(answer, REPLACE_ANSWER);
      assert.equal(server.seen.length, 1);
      assert.equal(server.seen[0].method, 'POST');
      assert.equal(server.seen[0].authorization, 'Bearer sre-agent-handoff-token');
      assert.deepEqual(server.seen[0].body, REQUEST);
    } finally {
      server.close();
    }
  });

  await check('askReplacement answers report and stopped as they came', async () => {
    for (const body of [{ decision: 'report' }, { decision: 'stopped', sentence: 'The change was ended.' }]) {
      const server = await platform([{ status: 200, body }]);
      try {
        assert.deepEqual(await internals.askReplacement({}, pushJob({ replacement_url: server.url }), REQUEST, null), body);
      } finally {
        server.close();
      }
    }
  });

  await check('askReplacement retries a 404 three times in all and answers unreachable', async () => {
    const server = await platform([{ status: 404, body: { error: 'not found' } }]);
    try {
      const answer = await internals.askReplacement({}, pushJob({ replacement_url: server.url }), REQUEST, null);
      assert.equal(answer.decision, 'unreachable');
      assert.equal(server.seen.length, 3);
    } finally {
      server.close();
    }
  });

  await check('askReplacement retries a 5xx, and takes the answer of the call that lands', async () => {
    const server = await platform([{ status: 503, body: {} }, { status: 502, body: {} }, { status: 200, body: { decision: 'report' } }]);
    try {
      const answer = await internals.askReplacement({}, pushJob({ replacement_url: server.url }), REQUEST, null);
      assert.deepEqual(answer, { decision: 'report' });
      assert.equal(server.seen.length, 3);
    } finally {
      server.close();
    }
  });

  await check('askReplacement does not retry a 409, which ends the run as stopped, nor a 422, which is unreachable', async () => {
    const conflict = await platform([{ status: 409, body: { error: 'conflict' } }]);
    try {
      const answer = await internals.askReplacement({}, pushJob({ replacement_url: conflict.url }), REQUEST, null);
      assert.equal(answer.decision, 'stopped');
      assert.equal(conflict.seen.length, 1);
    } finally {
      conflict.close();
    }
    const malformed = await platform([{ status: 422, body: { error: 'bad body' } }]);
    try {
      const answer = await internals.askReplacement({}, pushJob({ replacement_url: malformed.url }), REQUEST, null);
      assert.equal(answer.decision, 'unreachable');
      assert.equal(malformed.seen.length, 1);
    } finally {
      malformed.close();
    }
  });

  await check('askReplacement answers unreachable for a replace answer it cannot act on, without retrying', async () => {
    const broken = [
      { ...REPLACE_ANSWER, branch: '-evil' },
      { ...REPLACE_ANSWER, branch: 'a/../b' },
      { ...REPLACE_ANSWER, start_sha: 'abc' },
      { ...REPLACE_ANSWER, number: 8 },
      { ...REPLACE_ANSWER, closing: 'yes' },
      { ...REPLACE_ANSWER, draft: undefined },
      { ...REPLACE_ANSWER, title: '' },
      { decision: 'sideways' },
    ];
    for (const body of broken) {
      const server = await platform([{ status: 200, body }]);
      try {
        const answer = await internals.askReplacement({}, pushJob({ replacement_url: server.url }), REQUEST, null);
        assert.equal(answer.decision, 'unreachable', JSON.stringify(body));
        assert.equal(server.seen.length, 1);
      } finally {
        server.close();
      }
    }
  });

  await check('askReplacement stops between attempts when the job was taken from the runner', async () => {
    const server = await platform([{ status: 404, body: { error: 'not found' } }]);
    const controller = new AbortController();
    controller.abort('taken_over');
    try {
      await assert.rejects(() => internals.askReplacement({}, pushJob({ replacement_url: server.url }), REQUEST, controller.signal), /taken from this runner/);
    } finally {
      server.close();
    }
  });

  await check('the replacement request body is bounded: at most 100 paths of 300 characters, a 500 summary, a 20,000 analysis, a 300 push message', () => {
    const body = internals.replacementRequest(
      'alpha',
      {
        commit_sha: SHA,
        made_on: SHA,
        changed: Array.from({ length: 150 }, (_, index) => `${'p'.repeat(400)}${index}`),
        summary: 's'.repeat(900),
        analysis: 'a'.repeat(30000),
        reason: { kind: 'push_refused', message: 'm'.repeat(900) },
      }
    );
    assert.equal(body.paths.length, 100);
    assert.ok(body.paths.every((entry) => Array.from(entry).length <= 300));
    assert.ok(Array.from(body.summary).length <= 500);
    assert.ok(Array.from(body.analysis).length <= 20000);
    assert.ok(Array.from(body.reason.message).length <= 300);
    assert.equal(body.instance, 'alpha');
  });

  if (failed > 0) {
    console.log(`${failed} check(s) failed`);
    process.exit(1);
  }
}

main();
