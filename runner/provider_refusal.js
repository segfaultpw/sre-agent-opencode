'use strict';

// Telling an AI provider's refusal from every other way a run can end, and
// making the provider's own words safe to report.
//
// opencode prints a JSON `error` event for what went wrong inside a run. A run
// that exited non-zero because the provider refused the request (the key is
// wrong, the account is out of credit or quota, the rate limit held, the model
// is not there) names it in the last such event. The runner reports that as a
// refusal, with a class, the HTTP status and the provider's message, so the
// person who has to fix the key or the account is told which one, in the
// provider's words.
//
// Ambiguous means not a refusal. A refusal is not retried on another machine
// of the same runner and an `agent_exit` is, so a false "the provider refused"
// sends people to the wrong place, and a missed one costs one more try. A run
// that exited 0, a run the runner stopped, a last event no row below matches,
// and every 5xx, overload, network fault, context overflow or content filter is
// not a refusal. Only the last error event decides: a refusal the run got past
// is not one. Nothing is read from stderr.
//
// The words are scrubbed the way the platform scrubs them (the shape list and
// its order are the platform's, and tests/fixture/provider_messages.json pins
// both implementations to the same outputs, byte for byte): the secrets the
// runner holds are removed by value, every credential shape is masked, nothing
// invisible is left to hide a key from a mask, and what is left is one line of
// at most 500 bytes cut on a character. This module never logs.

const CLASSES = ['auth', 'billing', 'quota', 'rate_limit', 'model_not_found'];
const EVENTS_MAX = 20;
const RAW_MAX_CODE_POINTS = 2000;
const MESSAGE_MAX_BYTES = 500;

const READ_BYTES = 65536;
const MIN_SECRET_BYTES = 8;
const WRAPPED_LINES = 8;
const BODY_MAX_CHARS = 65536;
const BODY_FIELD_MAX_CHARS = 200;
const MASK = '[redacted]';
const GAP = '\x01';

// What is read out of one error event. The runner keeps the last EVENTS_MAX of
// them, each message already cut at RAW_MAX_CODE_POINTS.
function eventFrom(event) {
  if (!event || typeof event !== 'object' || event.type !== 'error') return null;
  const error = event.error;
  if (typeof error === 'string') {
    return { name: '', statusCode: null, message: cutRaw(error), bodyCode: null, providerID: null };
  }
  if (!error || typeof error !== 'object') {
    return { name: '', statusCode: null, message: '', bodyCode: null, providerID: null };
  }
  const data = error.data && typeof error.data === 'object' ? error.data : {};
  const message = typeof data.message === 'string' ? data.message : typeof error.message === 'string' ? error.message : '';
  return {
    name: typeof error.name === 'string' ? error.name : '',
    statusCode: statusOf(data.statusCode),
    message: cutRaw(message),
    bodyCode: bodyCodeOf(data.responseBody),
    providerID: typeof data.providerID === 'string' ? data.providerID.slice(0, BODY_FIELD_MAX_CHARS) : null,
  };
}

// The list a run keeps: the new event appended when it is an error event, the
// list cut to its last EVENTS_MAX. Returns the same array.
function remember(events, jsonEvent) {
  const event = eventFrom(jsonEvent);
  if (event) {
    events.push(event);
    while (events.length > EVENTS_MAX) events.shift();
  }
  return events;
}

function statusOf(value) {
  const number = typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : value;
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : null;
}

// The error.code, error.type or error.status of a response body that parses as
// JSON (or the top level `code`), joined, as text to match against. Strings
// only: a number is a status echoed, not a word. A body that is not JSON, or
// holds none of them, is null.
function bodyCodeOf(body) {
  let parsed = body;
  if (typeof body === 'string') {
    if (body.length === 0 || body.length > BODY_MAX_CHARS) return null;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const parts = [];
  const take = (value) => {
    if (typeof value === 'string' && value !== '') parts.push(value.slice(0, BODY_FIELD_MAX_CHARS));
  };
  if (parsed.error && typeof parsed.error === 'object') {
    take(parsed.error.code);
    take(parsed.error.type);
    take(parsed.error.status);
  }
  take(parsed.code);
  return parts.length > 0 ? parts.join(' ') : null;
}

// What a billing, quota or model signal looks like in the lower-cased message
// and body code. Loose words are not here on purpose: a bare "billing" or
// "does not exist" appears in a bug in our own request as easily as in a
// refusal.
const BILLING_400 = ['credit balance', 'billing_hard_limit', 'billing hard limit', 'billing account', 'insufficient funds', 'purchase credits', 'payment required', 'account is not active'];
const MODEL_400 = ['not_found_error', 'model_not_found', 'unknown model', 'model not found'];
const MODEL_MISSING_SENTENCE = /\bmodel\b[^.]{0,120}\bdoes not exist\b/;
const QUOTA_429 = ['insufficient_quota', 'exceeded your current quota', 'quota exceeded', 'free tier'];

function holdsAny(text, words) {
  return words.some((word) => text.includes(word));
}

function classOf(event) {
  if (event.name === 'ProviderAuthError') return 'auth';
  if (event.name !== 'APIError') return null;
  const text = `${event.message} ${event.bodyCode || ''}`.toLowerCase();
  switch (event.statusCode) {
    case 401:
    case 403:
      return 'auth';
    case 402:
      return 'billing';
    case 404:
      return 'model_not_found';
    case 400: {
      const found = [];
      if (holdsAny(text, BILLING_400)) found.push('billing');
      if (holdsAny(text, MODEL_400) || MODEL_MISSING_SENTENCE.test(text)) found.push('model_not_found');
      return found.length === 1 ? found[0] : null;
    }
    case 429:
      return holdsAny(text, QUOTA_429) || (text.includes('resource_exhausted') && text.includes('quota')) ? 'quota' : 'rate_limit';
    default:
      return null;
  }
}

// events: what remember() kept. run: {exitCode, stopped}, stopped being true
// for a run the runner ended (a timeout, an abort, a process left behind).
// options: {redact, secrets}, as scrub() takes them. Returns
// {class, status, message} (message null when nothing is left of it) or null.
function classify(events, run, options = {}) {
  if (!run || !Number.isInteger(run.exitCode) || run.exitCode === 0 || run.stopped) return null;
  const list = Array.isArray(events) ? events.slice(-EVENTS_MAX) : [];
  if (list.length === 0) return null;
  const last = list[list.length - 1];
  const kind = last && classOf(last);
  if (!kind) return null;
  const message = scrub(last.message, options.redact, options.secrets);
  return { class: kind, status: last.statusCode, message: message === '' ? null : message };
}

// ---------------------------------------------------------------------------
// The scrubber. One reading of the text, in this order:
//   1. at most the first 65,536 bytes, a token the cut ended inside of dropped;
//   2. escape sequences and invisible characters removed;
//   3. every run of whitespace and control characters one space, or one gap
//      byte when the run holds a control character or a line break, which the
//      steps below see through;
//   4. the secrets the runner holds, by value, a gap allowed between any two
//      characters (the secrets of 8 bytes or more: a placeholder key would wipe
//      its own letters from every message);
//   5. the credential shapes;
//   6. gaps become spaces, runs of spaces one space, trimmed, 500 bytes cut on
//      a character.
// ---------------------------------------------------------------------------

// A token the cut ended inside of is dropped whole, and so is the token before
// it when a line break separates the two (a key a terminal wrapped across the
// cut). Bytes, because the bound is one.
function keyByte(byte) {
  return (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x30 && byte <= 0x39) || [0x2b, 0x2f, 0x3d, 0x5f, 0x2d].includes(byte);
}

function keyStart(buffer, size) {
  let at = size;
  while (at > 0 && keyByte(buffer[at - 1])) at -= 1;
  return at;
}

function spaceStart(buffer, size) {
  let at = size;
  while (at > 0 && buffer[at - 1] <= 0x20) at -= 1;
  return at;
}

function hasControl(buffer, from, to) {
  for (let at = from; at < to; at += 1) if (buffer[at] < 0x20) return true;
  return false;
}

function tokenEnd(buffer, start, lines) {
  let size = start;
  for (;;) {
    if (size === 0) return 0;
    const afterKey = keyStart(buffer, size);
    const afterGap = spaceStart(buffer, afterKey);
    if (lines > 0 && afterGap > 0 && afterGap < afterKey && hasControl(buffer, afterGap, afterKey)) {
      size = afterGap;
      lines -= 1;
    } else {
      return afterKey;
    }
  }
}

function dropOpenToken(buffer) {
  return buffer.subarray(0, tokenEnd(buffer, buffer.length, WRAPPED_LINES));
}

// A byte cut of valid UTF-8 without the character it may have cut in half.
function completeCharacters(buffer) {
  if (buffer.length === 0) return buffer;
  let lead = buffer.length - 1;
  while (lead > 0 && (buffer[lead] & 0xc0) === 0x80) lead -= 1;
  const first = buffer[lead];
  const wanted = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
  return lead + wanted > buffer.length ? buffer.subarray(0, lead) : buffer;
}

function readBounded(text) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= READ_BYTES) return text;
  return dropOpenToken(completeCharacters(buffer.subarray(0, READ_BYTES))).toString('utf8');
}

// What an event's message is cut to before anything else is done with it: 2,000
// code points, the token the cut ended inside of dropped like the scrubber's own
// read does.
function cutRaw(text) {
  if (text.length <= RAW_MAX_CODE_POINTS) return text;
  const points = Array.from(text.length > RAW_MAX_CODE_POINTS * 2 ? text.slice(0, RAW_MAX_CODE_POINTS * 2) : text);
  if (text.length <= RAW_MAX_CODE_POINTS * 2 && points.length <= RAW_MAX_CODE_POINTS) return text;
  return dropOpenToken(Buffer.from(points.slice(0, RAW_MAX_CODE_POINTS).join(''), 'utf8')).toString('utf8');
}

// Control sequences a terminal writes around text: CSI, OSC (until BEL or ST,
// or the end of the line), the string controls DCS, SOS, PM and APC (until ST),
// and any other two or three byte escape.
const ESCAPES = /\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07\x1B\n]*(?:\x07|\x1B\\)?|\x1B[PX^_][^\x07\x1B\n]*(?:\x1B\\)?|\x1B[ -/]*[0-~]/g;
// Every format character, the combining grapheme joiner, the variation
// selectors and the invalid-byte stand-in Node decodes a bad byte to.
const INVISIBLE = /[\p{Cf}\u034F\uFE00-\uFE0F\u{E0100}-\u{E01EF}\uFFFD]/gu;
const SPACE_RUN = /[\x00-\x20\x7F-\xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/gu;
const HARD_WHITESPACE = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/u;

function strip(text) {
  return text.replace(ESCAPES, '').replace(INVISIBLE, '');
}

function gaps(text) {
  return text.replace(SPACE_RUN, (run) => (HARD_WHITESPACE.test(run) ? GAP : ' '));
}

// The characters of a literal with a gap allowed between each two, as a pattern.
function literal(text) {
  return Array.from(text)
    .map((character) => character.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&'))
    .join('\\x01*');
}

function alt(names) {
  return names.map(literal).join('|');
}

const QUERY_NAMES = ['access_token', 'id_token', 'refresh_token', 'token', 'api_key', 'apikey', 'api-key', 'key', 'secret', 'client_secret', 'password', 'passwd', 'pwd', 'signature', 'sig', 'auth', 'authorization', 'x-api-key'];
const JSON_NAMES = [...QUERY_NAMES, 'secret_access_key', 'secretaccesskey', 'aws_secret_access_key', 'session_token', 'x-goog-api-key'];
const HEADER_NAMES = ['x-api-key', 'x-goog-api-key', 'api-key', 'authorization', 'proxy-authorization', 'x-auth-token'];
const SCHEMES = ['basic', 'bearer', 'digest', 'negotiate', 'ntlm', 'token', 'apikey', 'api-key', 'key', 'hmac'];

const GAP_STAR = '\\x01*';
const WS = '[\\s\\x01]';
const TOKEN = '[^\\s\\x01]+(?:\\x01+[^\\s\\x01]+)*';
const JSON_VALUE = '[^"\'\\s,}\\x01]+(?:\\x01+[^"\'\\s,}\\x01]+)*';
const NOT_IN_WORD = '(?<![A-Za-z0-9])';

function run(characterClass) {
  return `(${characterClass}+(?:\\x01+${characterClass}+)*)`;
}

function segment() {
  return '[A-Za-z0-9_-]+(?:\\x01+[A-Za-z0-9_-]+)*';
}

// A `count` rule masks the whole match only when its first group (the run of
// key characters, the gaps between them not counted) holds at least `minimum`
// characters, which is how `{20,}` is written once gaps are allowed inside a run.
function count(source, minimum) {
  return [new RegExp(source, 'g'), (whole, keyRun) => (keyRun.split(GAP).join('').length >= minimum ? MASK : whole)];
}

function replace(source, flags, replacement) {
  return [new RegExp(source, `g${flags}`), replacement];
}

const SHAPES = [
  replace(`([?&;#])${GAP_STAR}(${alt(QUERY_NAMES)})${GAP_STAR}=[^&\\s"'<>]+`, 'i', (_whole, mark, name) => `${mark}${name}=${MASK}`),
  replace(`(:${GAP_STAR}/${GAP_STAR}/)[^/\\s:@]+:[^/\\s@]+@`, '', (_whole, scheme) => `${scheme}${MASK}@`),
  count(NOT_IN_WORD + literal('sk-ant-') + GAP_STAR + run('[A-Za-z0-9_-]'), 20),
  count(NOT_IN_WORD + literal('sk-') + GAP_STAR + run('[A-Za-z0-9_-]'), 20),
  replace(`\\b(?:${literal('AKIA')}|${literal('ASIA')})${GAP_STAR}(?:[0-9A-Z]${GAP_STAR}){15}[0-9A-Z](?![A-Za-z0-9_])`, '', () => MASK),
  replace(`${literal('AIza')}${GAP_STAR}(?:[0-9A-Za-z_-]${GAP_STAR}){34}[0-9A-Za-z_-]`, '', () => MASK),
  count(`\\bg${GAP_STAR}h${GAP_STAR}[pousr]${GAP_STAR}_${GAP_STAR}${run('[A-Za-z0-9]')}`, 20),
  count(literal('github_pat_') + GAP_STAR + run('[A-Za-z0-9_]'), 20),
  count(`x${GAP_STAR}o${GAP_STAR}x${GAP_STAR}[abprs]${GAP_STAR}-${GAP_STAR}${run('[A-Za-z0-9-]')}`, 10),
  count(NOT_IN_WORD + literal('hf_') + GAP_STAR + run('[A-Za-z0-9]'), 30),
  count(NOT_IN_WORD + literal('r8_') + GAP_STAR + run('[A-Za-z0-9]'), 30),
  count(NOT_IN_WORD + literal('fw_') + GAP_STAR + run('[A-Za-z0-9]'), 20),
  count(NOT_IN_WORD + literal('glpat-') + GAP_STAR + run('[A-Za-z0-9_-]'), 20),
  count(
    `${NOT_IN_WORD}(?:${literal('sk')}|${literal('rk')})${GAP_STAR}_${GAP_STAR}(?:${literal('live')}|${literal('test')})${GAP_STAR}_${GAP_STAR}${run('[A-Za-z0-9]')}`,
    16
  ),
  count(NOT_IN_WORD + literal('npm_') + GAP_STAR + run('[A-Za-z0-9]'), 30),
  replace(`${literal('bearer')}${WS}+${TOKEN}`, 'i', () => `Bearer ${MASK}`),
  replace(`((?:${alt(HEADER_NAMES)})${WS}*[:=]${WS}*(?:(?:${alt(SCHEMES)})${WS}+)?)${TOKEN}`, 'i', (_whole, head) => `${head}${MASK}`),
  replace(
    `(["']${GAP_STAR}(?:${alt(JSON_NAMES)})${GAP_STAR}["']${WS}*[:=]${WS}*["']?${GAP_STAR}(?:(?:${alt(SCHEMES)})${WS}+)?)${JSON_VALUE}`,
    'i',
    (_whole, head) => `${head}${MASK}`
  ),
  replace(`(?<![A-Za-z0-9_-])${literal('eyJ')}${GAP_STAR}${segment()}${GAP_STAR}\\.${GAP_STAR}${segment()}${GAP_STAR}\\.${GAP_STAR}${segment()}`, '', () => MASK),
  count(run('[A-Za-z0-9+/=_-]'), 48),
];

// What an endpoint that echoes a request may quote of one secret: the string
// itself, percent-encoded (a query string, a form body), JSON-escaped, and with
// a `/` escaped by a PHP or Ruby encoder. The longest form goes first, so a
// secret that is a prefix of another leaves nothing of the longer one behind.
function removalForms(secret) {
  const unreserved = /[A-Za-z0-9\-._~]/;
  const percent = (text, spaceAs) =>
    Array.from(Buffer.from(text, 'utf8'))
      .map((byte) => {
        const character = String.fromCharCode(byte);
        if (byte < 0x80 && unreserved.test(character)) return character;
        if (byte === 0x20) return spaceAs;
        return `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      })
      .join('');
  const json = JSON.stringify(secret).slice(1, -1);
  return [secret, percent(secret, '+'), percent(secret, '%20'), json, secret.split('/').join('\\/'), json.split('/').join('\\/')];
}

function removeKnown(text, secrets) {
  const forms = [];
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < MIN_SECRET_BYTES) continue;
    for (const form of removalForms(secret)) if (!forms.includes(form)) forms.push(form);
  }
  if (forms.length === 0) return text;
  forms.sort((a, b) => Buffer.byteLength(b) - Buffer.byteLength(a));
  return text.replace(new RegExp(forms.map(literal).join('|'), 'g'), MASK);
}

function cutBytes(text, max) {
  if (Buffer.byteLength(text) <= max) return text;
  let out = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > max) break;
    out += character;
    bytes += size;
  }
  return out;
}

function finish(text) {
  const oneLine = text.split(GAP).join(' ').split(' ').filter(Boolean).join(' ');
  return cutBytes(oneLine, MESSAGE_MAX_BYTES).trim();
}

// message: the provider's words. redact: the runner's own redact(), which
// removes by value every secret the runner holds, run on the raw text and again
// on the result. secrets: those values, for the removal that sees through a line
// break. Returns one line of at most 500 bytes, or '' when nothing is left. It
// never throws and never logs.
function scrub(message, redact, secrets) {
  if (typeof message !== 'string') return '';
  const own = typeof redact === 'function' ? redact : (text) => text;
  try {
    const known = readBounded(own(message));
    const text = finish(SHAPES.reduce((current, [regex, replacement]) => current.replace(regex, replacement), removeKnown(gaps(strip(known)), secrets)));
    return own(text);
  } catch {
    return '';
  }
}

module.exports = { CLASSES, EVENTS_MAX, RAW_MAX_CODE_POINTS, MESSAGE_MAX_BYTES, eventFrom, remember, classify, scrub, cutBytes };
