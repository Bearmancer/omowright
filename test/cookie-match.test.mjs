// Security contract: a cookie read keeps only cookies the browser would send to the target URL, so an endpoint that
// ignores the `urls` filter of Network.getCookies cannot make one site's cookies reach another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cookieAppliesToUrl } from "../src/cookie-match.js";

test("an endpoint that answered with the page's cookies cannot leak them to another site", () => {
  const pageCookies = [
    { name: "page_secret", value: "1", domain: "127.0.0.1", path: "/", secure: false },
    { name: "shared", value: "1", domain: ".example.com", path: "/", secure: false },
  ];
  const sentTo = (url) => pageCookies.filter((cookie) => cookieAppliesToUrl(cookie, url)).map((cookie) => cookie.name);

  assert.deepEqual(sentTo("http://localhost:8080/"), []);
  assert.deepEqual(sentTo("http://evil.example.net/"), []);
  assert.deepEqual(sentTo("http://notexample.com/"), []);
  assert.deepEqual(sentTo("http://127.0.0.1:9999/any"), ["page_secret"]);
  assert.deepEqual(sentTo("https://a.example.com/x"), ["shared"]);
  assert.deepEqual(sentTo("https://example.com/"), ["shared"]);
});

test("an IP host matches only a cookie for that exact IP, never a domain suffix (RFC 6265 5.1.3)", () => {
  const cookie = (domain) => ({ name: "c", value: "1", domain, path: "/", secure: false });
  assert.equal(cookieAppliesToUrl(cookie(".0.0.1"), "http://127.0.0.1/"), false);
  assert.equal(cookieAppliesToUrl(cookie(".168.1.10"), "http://192.168.1.10/"), false);
  assert.equal(cookieAppliesToUrl(cookie(".1"), "http://[::1]/"), false);
  assert.equal(cookieAppliesToUrl(cookie("127.0.0.1"), "http://127.0.0.1/"), true);
  assert.equal(cookieAppliesToUrl(cookie(".127.0.0.1"), "http://127.0.0.1/"), true);
});

test("path and secure rules match the browser's", () => {
  const cookie = (extra) => ({ name: "c", value: "1", domain: "site.test", path: "/app", secure: false, ...extra });
  assert.equal(cookieAppliesToUrl(cookie(), "http://site.test/app"), true);
  assert.equal(cookieAppliesToUrl(cookie(), "http://site.test/app/page"), true);
  assert.equal(cookieAppliesToUrl(cookie(), "http://site.test/apple"), false);
  assert.equal(cookieAppliesToUrl(cookie(), "http://site.test/"), false);
  assert.equal(cookieAppliesToUrl(cookie({ secure: true }), "http://site.test/app"), false);
  assert.equal(cookieAppliesToUrl(cookie({ secure: true }), "https://site.test/app"), true);
  assert.equal(cookieAppliesToUrl(cookie({ domain: "" }), "http://site.test/app"), false);
  assert.equal(cookieAppliesToUrl(cookie(), "file:///etc/passwd"), false);
  assert.equal(cookieAppliesToUrl(cookie(), "not a url"), false);
});
