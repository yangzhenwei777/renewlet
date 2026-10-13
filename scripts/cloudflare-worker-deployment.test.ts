import assert from "node:assert/strict";
import test from "node:test";
import { readActiveWorkerDeployment } from "./cloudflare-worker-deployment";

const access = { accountId: "isolated-account", apiToken: "fixture-secret", workerName: "isolated-worker" };
const versionId = "12345678-abcd-4321-abcd-1234567890ab";
const response = (body: unknown, status = 200): typeof fetch => async () => Response.json(body, { status });
const deployment = { versions: [{ version_id: versionId, percentage: 100 }] };

test("first installation accepts the actual Cloudflare 10007 response and an empty deployment history", async () => {
  assert.equal(await readActiveWorkerDeployment(access, response({
    success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }],
  }, 404)), undefined);
  assert.equal(await readActiveWorkerDeployment(access, response({
    success: true, errors: [], result: { deployments: [] },
  })), undefined);
});

test("reads the latest deployment with explicit account and Worker scope", async () => {
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.cloudflare.com/client/v4/accounts/isolated-account/workers/scripts/isolated-worker/deployments");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-secret");
    assert.ok(init?.signal);
    return Response.json({ success: true, errors: [], result: { deployments: [deployment, { versions: [] }] } });
  };
  assert.deepEqual(await readActiveWorkerDeployment(access, request), { versionId });
});

test("permissions, platform errors and human missing-Worker text never authorize a fresh install", async () => {
  for (const status of [403, 404, 429, 500]) {
    await assert.rejects(readActiveWorkerDeployment(access, response({
      success: false, errors: [{ code: 10000, message: "Worker not found fixture-secret" }],
    }, status)), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(readActiveWorkerDeployment(access, response({
    success: false, errors: [{ code: 10007 }, { code: 10000 }],
  }, 404)), /HTTP 404/);
  await assert.rejects(readActiveWorkerDeployment(access, response({
    success: false, errors: [{ code: 10007 }],
  }, 403)), /HTTP 403/);
});

test("network errors and invalid envelopes fail closed without raw provider details", async () => {
  for (const request of [
    (async () => { throw new Error("fixture-secret"); }) as typeof fetch,
    (async () => new Response("fixture-secret")) as typeof fetch,
    response(null), response({ success: true, errors: [], result: {} }),
    response({ success: true, errors: [], result: { deployments: [null] } }),
  ]) {
    await assert.rejects(readActiveWorkerDeployment(access, request), (error: unknown) =>
      error instanceof Error && !error.message.includes("fixture-secret"));
  }
});

test("split traffic and malformed active versions block migrations", async () => {
  for (const versions of [[], [{ version_id: versionId, percentage: 50 }],
    [{ version_id: versionId, percentage: 100 }, { version_id: versionId, percentage: 0 }],
    [{ version_id: "unsafe\nversion", percentage: 100 }]]) {
    await assert.rejects(readActiveWorkerDeployment(access, response({
      success: true, errors: [], result: { deployments: [{ versions }] },
    })), /one active Worker version/);
  }
});

test("missing credentials never issue a request", async () => {
  const request: typeof fetch = async () => { assert.fail("unexpected request"); };
  await assert.rejects(readActiveWorkerDeployment({ ...access, apiToken: "" }, request), /requires an account/);
});
