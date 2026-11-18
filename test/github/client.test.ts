import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { GitHubClient, GitHubError, paginate } from '../../src/github/client.ts';
import { Secret } from '../../src/secrets.ts';

const TOKEN = 'fake-github-token-for-test';
const QUERY = 'query Viewer { viewer { login } }';
const NOW = Date.parse('2026-11-18T00:00:00Z');

function fakeClient(...responses: (Response | Error)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const waits: number[] = [];
  let now = NOW;
  const client = new GitHubClient(new Secret('github.token', TOKEN), {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      const response = responses.shift();
      assert.ok(response, 'unexpected fetch');
      if (response instanceof Error) throw response;
      return response;
    },
    sleep: async ms => {
      waits.push(ms);
      now += ms;
    },
    now: () => now,
  });
  return { client, calls, waits };
}

test('GraphQL and REST use the same GitHub credential and JSON transport', async () => {
  const { client, calls } = fakeClient(
    Response.json({ data: { viewer: { login: 'orchid' } } }),
    new Response(null, { status: 204 }),
  );
  assert.deepEqual(await client.graphql(QUERY, { unused: 'example' }), { viewer: { login: 'orchid' } });
  assert.equal(await client.rest<void>('/repos/owner/name/issues/1/labels/ready', { method: 'DELETE' }), undefined);
  assert.deepEqual(calls.map(call => call.url), [
    'https://api.github.com/graphql', 'https://api.github.com/repos/owner/name/issues/1/labels/ready',
  ]);
  const [graphql, rest] = calls.map(call => call.init);
  assert.equal(graphql?.method, 'POST');
  assert.equal(rest?.method, 'DELETE');
  assert.deepEqual(JSON.parse(String(graphql?.body)), { query: QUERY, variables: { unused: 'example' } });
  for (const call of calls) {
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(headers.get('x-github-api-version'), '2022-11-28');
  }
  await assert.rejects(client.rest('//example.com/path'), /GitHub API origin/);
  assert.equal(calls.length, 2);
});

test('5xx retries use backoff and honor both forms of Retry-After', async () => {
  const { client, waits } = fakeClient(
    new Response('upstream error', { status: 502 }),
    new Response(null, { status: 503, headers: { 'retry-after': new Date(NOW + 6_000).toUTCString() } }),
    Response.json({ ok: true }),
  );
  assert.deepEqual(await client.rest('/rate_limit'), { ok: true });
  assert.deepEqual(waits, [1_000, 5_000]);

  const retry = fakeClient(
    Response.json({ message: 'You have exceeded a secondary rate limit.' }, {
      status: 403, headers: { 'retry-after': '3' },
    }),
    Response.json({ ok: true }),
  );
  await retry.client.rest('/rate_limit');
  assert.deepEqual(retry.waits, [3_000]);
});

test('GitHub primary limit reset applies to a retry and to the next request after success', async () => {
  const limit = (afterMs: number) => ({
    'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((NOW + afterMs) / 1000),
  });
  const { client, waits } = fakeClient(
    Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: limit(8_000) }),
    Response.json({ data: { viewer: { login: 'orchid' } } }, { headers: limit(13_000) }),
    Response.json({ ok: true }),
  );
  await client.graphql(QUERY);
  await client.rest('/rate_limit');
  assert.deepEqual(waits, [8_000, 5_000]);
});

test('rate limits without a delay header back off and report the cooldown after retries run out', async () => {
  const limited = () => Response.json({ errors: [{ type: 'RATE_LIMITED', message: 'rate limited' }] });
  const secondary = Response.json({ message: 'You have exceeded a secondary rate limit.' }, {
    status: 403, headers: { 'x-ratelimit-remaining': '42' },
  });
  const { client, waits } = fakeClient(secondary, limited(), limited(), Response.json({ ok: true }));
  await assert.rejects(client.graphql(QUERY), (error: unknown) => {
    assert.ok(error instanceof GitHubError);
    assert.equal(error.retryAfterMs, 240_000);
    return true;
  });
  assert.deepEqual(waits, [60_000, 120_000]);
  await client.rest('/rate_limit');
  assert.deepEqual(waits, [60_000, 120_000, 240_000]);
});

test('REST writes and opted-out GraphQL mutations do not replay 5xx responses', async () => {
  const { client, calls, waits } = fakeClient(new Response(null, { status: 500 }), new Response(null, { status: 502 }));
  await assert.rejects(client.rest('/repos/owner/name/issues', { method: 'POST', body: { title: 'Task' } }), /GitHub HTTP 500/);
  await assert.rejects(client.graphql('mutation Write { example }', {}, { retryServerErrors: false }), /GitHub HTTP 502/);
  assert.deepEqual(waits, []);
  assert.equal(calls.length, 2);
});

test('request, HTTP, and GraphQL errors redact a token echoed in diagnostics', async () => {
  const { client, calls } = fakeClient(
    new Error(`fetch failed with Bearer ${TOKEN}`),
    Response.json({ message: `Bad credential ${TOKEN}` }, { status: 401 }),
    Response.json({ data: { viewer: {} }, errors: [{ message: `Denied for ${TOKEN}` }] }),
  );
  const redacted = (error: unknown) => {
    assert.ok(error instanceof GitHubError);
    assert.ok(error.message.includes('[secret github.token]'));
    assert.ok(!inspect(error).includes(TOKEN));
    assert.equal(error.cause, undefined);
    return true;
  };
  await assert.rejects(client.rest('/rate_limit'), redacted);
  await assert.rejects(client.rest('/rate_limit'), redacted);
  await assert.rejects(client.graphql(QUERY), redacted);
  assert.equal(calls.length, 3);
});

test('pagination skips null nodes and rejects a repeated cursor', async () => {
  const cursors: (string | null)[] = [];
  const values: number[] = [];
  const pages = paginate(async cursor => {
    cursors.push(cursor);
    return { nodes: [null, cursors.length], pageInfo: { hasNextPage: true, endCursor: 'same' } };
  });
  await assert.rejects(async () => {
    for await (const value of pages) values.push(value);
  }, /pagination did not advance/);
  assert.deepEqual(cursors, [null, 'same']);
  assert.deepEqual(values, [1, 2]);
});
