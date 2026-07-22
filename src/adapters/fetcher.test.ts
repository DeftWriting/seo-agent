import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicUrl, htmlToText, isPublicIpAddress, resolvePublicRedirect } from "./fetcher.js";

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

test("redirect targets are revalidated before following them", async () => {
  await assert.rejects(
    () => resolvePublicRedirect(new URL("https://1.1.1.1"), "http://127.0.0.1/private"),
    /Private or reserved/,
  );
  assert.equal(
    (await resolvePublicRedirect(new URL("https://1.1.1.1/base"), "/next")).toString(),
    "https://1.1.1.1/next",
  );
});

test("htmlToText strips page chrome so nav/footer/CTA phrasing never reaches research", () => {
  const html = `<html><head><title>Example Co</title></head><body>
    <nav>Home About Pricing</nav>
    <header><div>Sign up for our newsletter</div></header>
    <main><p>Example Co helps teams ship faster.</p></main>
    <aside>Related posts you might like</aside>
    <footer>Copyright 2026 Example Co. All rights reserved.</footer>
  </body></html>`;
  const { title, text } = htmlToText(html);
  assert.equal(title, "Example Co");
  assert.match(text, /helps teams ship faster/);
  assert.doesNotMatch(text, /newsletter/i);
  assert.doesNotMatch(text, /Related posts/i);
  assert.doesNotMatch(text, /Copyright/i);
  assert.doesNotMatch(text, /Home About Pricing/);
});
