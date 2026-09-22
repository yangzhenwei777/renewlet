import assert from "node:assert/strict";
import test from "node:test";
import { bindLocalD1Parameters, D1RemoteClient } from "./cloudflare-d1-client";

function d1Response(results: readonly unknown[], status = 200, headers?: HeadersInit): Response {
  const init: ResponseInit = headers === undefined ? { status } : { status, headers };
  return new Response(
    JSON.stringify({ success: status >= 200 && status < 300, result: results, errors: [] }),
    init,
  );
}

function successResult(results: readonly unknown[]): Record<string, unknown> {
  return { success: true, results: [...results] };
}

test("binds local D1 values without rewriting SQL literals, identifiers, or comments", () => {
  const sql = [
    `SELECT ? AS text_value, ? AS number_value, ? AS null_value, '?' AS literal_value,`,
    `       "?" AS quoted_identifier, \`?\` AS backtick_identifier, [?] AS bracket_identifier`,
    `-- ? in a line comment`,
    `/* ? in a block comment */`,
  ].join("\n");

  assert.equal(
    bindLocalD1Parameters(sql, ["O'Brien", 42, null]),
    [
      `SELECT 'O''Brien' AS text_value, 42 AS number_value, NULL AS null_value, '?' AS literal_value,`,
      `       "?" AS quoted_identifier, \`?\` AS backtick_identifier, [?] AS bracket_identifier`,
      `-- ? in a line comment`,
      `/* ? in a block comment */`,
    ].join("\n"),
  );
});

test("rejects local D1 parameter count drift and unsupported numbered placeholders", () => {
  assert.throws(
    () => bindLocalD1Parameters("SELECT ?, ?", [1]),
    /fewer parameters than placeholders/,
  );
  assert.throws(
    () => bindLocalD1Parameters("SELECT ?", [1, 2]),
    /more parameters than placeholders/,
  );
  assert.throws(
    () => bindLocalD1Parameters("SELECT ?1", [1]),
    /only supports anonymous question-mark placeholders/,
  );
});

test("uses the official single-statement and batch request bodies", async () => {
  const calls: RequestInit[] = [];
  const responses = [
    d1Response([successResult([{ value: 1 }])]),
    d1Response([successResult([{ order: 1 }]), successResult([{ order: 2 }])]),
  ];
  const fetchMock: typeof fetch = async (_input, init) => {
    calls.push(init ?? {});
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected fetch call");
    return response;
  };
  const client = new D1RemoteClient("account", "database", "token", { fetch: fetchMock });

  const rows = await client.query("SELECT ? AS value", [1], (value): unknown => value);
  assert.deepEqual(rows, [{ value: 1 }]);
  const batch = await client.batch([
    { sql: "SELECT 1", params: [] },
    { sql: "SELECT ?", params: [2] },
  ]);
  assert.deepEqual(batch.map((entry) => entry.results), [[{ order: 1 }], [{ order: 2 }]]);

  const singleBody = calls.at(0)?.body;
  const batchBody = calls.at(1)?.body;
  if (typeof singleBody !== "string" || typeof batchBody !== "string") {
    assert.fail("D1 REST requests must serialize JSON into string bodies");
  }
  assert.deepEqual(JSON.parse(singleBody), { sql: "SELECT ? AS value", params: [1] });
  assert.deepEqual(JSON.parse(batchBody), {
    batch: [
      { sql: "SELECT 1" },
      { sql: "SELECT ?", params: [2] },
    ],
  });
  assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
});

test("does not issue a request for an empty batch", async () => {
  let requestCount = 0;
  const fetchMock: typeof fetch = async () => {
    requestCount += 1;
    return d1Response([]);
  };
  const client = new D1RemoteClient("account", "database", "token", { fetch: fetchMock });
  assert.deepEqual(await client.batch([]), []);
  assert.equal(requestCount, 0);
});

test("rejects invalid JSON, unsuccessful results, and result-count drift", async () => {
  const responses = [
    new Response("not-json", { status: 200 }),
    d1Response([{ success: false, results: [] }]),
    d1Response([successResult([])]),
  ];
  const fetchMock: typeof fetch = async () => {
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected fetch call");
    return response;
  };
  const client = new D1RemoteClient("account", "database", "token", { fetch: fetchMock });

  await assert.rejects(client.batch([{ sql: "SELECT 1" }]), /invalid JSON/);
  await assert.rejects(client.batch([{ sql: "SELECT 1" }]), /unsuccessful result/);
  await assert.rejects(client.batch([{ sql: "SELECT 1" }, { sql: "SELECT 2" }]), /unexpected result count/);
});

test("retries only transient HTTP, D1 reset, and network failures", async () => {
  const sleeps: number[] = [];
  let requestCount = 0;
  const fetchMock: typeof fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "busy" }] }), {
        status: 429,
        headers: { "retry-after": "2" },
      });
    }
    if (requestCount === 2) {
      return new Response("upstream unavailable", { status: 503 });
    }
    if (requestCount === 3) {
      return new Response(JSON.stringify({
        success: false,
        errors: [{ code: 7429, message: "D1 DB storage operation exceeded timeout" }],
      }), { status: 200 });
    }
    if (requestCount === 4) throw new DOMException("timed out", "TimeoutError");
    return d1Response([successResult([{ ok: true }])]);
  };
  const client = new D1RemoteClient("account", "database", "token", {
    fetch: fetchMock,
    maxAttempts: 6,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 5_000,
    random: () => 0,
    now: () => 0,
    sleep: async (delayMs): Promise<void> => { sleeps.push(delayMs); },
  });

  const results = await client.batch([{ sql: "SELECT 1" }]);
  assert.deepEqual(results.at(0)?.results, [{ ok: true }]);
  assert.equal(requestCount, 5);
  assert.deepEqual(sleeps, [2_000, 200, 400, 800]);
});

test("does not retry client, SQL, or protocol errors", async () => {
  const responses = [
    new Response(JSON.stringify({
      success: false,
      errors: [{ code: 7400, message: "near private_subscription_name: bad SQL" }],
    }), { status: 400 }),
    new Response(JSON.stringify({
      success: false,
      errors: [{ code: 7400, message: "near private_subscription_name: bad SQL" }],
    }), { status: 200 }),
  ];
  let requestCount = 0;
  const fetchMock: typeof fetch = async () => {
    requestCount += 1;
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected fetch call");
    return response;
  };
  const client = new D1RemoteClient("account", "database", "token", {
    fetch: fetchMock,
    sleep: async (): Promise<void> => { throw new Error("Non-retryable request attempted to sleep"); },
  });

  for (const expectedStatus of [400, 200]) {
    await assert.rejects(client.batch([{ sql: "INVALID" }]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`HTTP ${expectedStatus}`));
      assert.match(error.message, /code 7400/);
      assert.doesNotMatch(error.message, /private_subscription_name|bad SQL/);
      return true;
    });
  }
  assert.equal(requestCount, 2);
});

test("retries a transient failure reported by an individual batch result", async () => {
  let requestCount = 0;
  const fetchMock: typeof fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return d1Response([{
        success: false,
        error: "D1 DB storage operation exceeded timeout near private_subscription_name",
        code: 7429,
        results: [],
      }]);
    }
    return d1Response([successResult([{ ok: true }])]);
  };
  const client = new D1RemoteClient("account", "database", "token", {
    fetch: fetchMock,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    sleep: async (): Promise<void> => {},
  });

  assert.deepEqual(await client.batch([{ sql: "SELECT 1" }]), [successResult([{ ok: true }])]);
  assert.equal(requestCount, 2);
});

test("stops after the configured retry budget without exposing statements", async () => {
  let requestCount = 0;
  const fetchMock: typeof fetch = async () => {
    requestCount += 1;
    throw new TypeError("fetch failed");
  };
  const client = new D1RemoteClient("account", "database", "token", {
    fetch: fetchMock,
    maxAttempts: 3,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    sleep: async (): Promise<void> => {},
  });

  await assert.rejects(
    client.batch([{ sql: "SELECT secret FROM settings", params: ["private-value"] }]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /after 3 attempts/);
      assert.doesNotMatch(error.message, /secret|private-value/);
      return true;
    },
  );
  assert.equal(requestCount, 3);
});
