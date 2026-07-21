import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicUrl, isPublicIpAddress, safeFetch } from "./fetcher.js";

test("rejects private, loopback, link-local, and reserved IP addresses", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.equal(isPublicIpAddress("1.1.1.1"), true);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
});

test("URL validation rejects unsafe protocols, credentials, ports, and IP literals", async () => {
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"));
  await assert.rejects(() => assertPublicUrl("http://user:pass@example.com"));
  await assert.rejects(() => assertPublicUrl("http://127.0.0.1"));
  await assert.rejects(() => assertPublicUrl("https://1.1.1.1:8443"));
  assert.equal((await assertPublicUrl("https://1.1.1.1/path")).hostname, "1.1.1.1");
});

test("safe fetch revalidates every redirect before following it", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  }) as typeof fetch;
  try {
    await assert.rejects(() => safeFetch("https://1.1.1.1"), /Private or reserved/);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
