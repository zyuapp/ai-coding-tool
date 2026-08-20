import assert from "node:assert/strict";
import test from "node:test";
import { chromeHeaders, chromeIdentity } from "../dist/main/main/browser-headers.js";

const identity = chromeIdentity("150.0.7871.224");

test("the user agent names the Chrome this build is", () => {
  assert.equal(
    identity.userAgent,
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  );
  assert.ok(!identity.userAgent.includes("Electron"));
});

test("the hints agree with the version the user agent claims", () => {
  const headers = chromeHeaders("https://example.com/", {}, identity);
  assert.equal(headers["Sec-CH-UA"], '"Chromium";v="150", "Google Chrome";v="150", "Not?A_Brand";v="24"');
  assert.equal(headers["Sec-CH-UA-Mobile"], "?0");
  assert.equal(headers["Sec-CH-UA-Platform"], '"macOS"');
  assert.equal(headers["Accept-Language"], "en-US,en;q=0.9");
});

test("Chromium's own hints are replaced rather than sent alongside", () => {
  const headers = chromeHeaders("https://example.com/", { "sec-ch-ua": '"Chromium";v="150"', "accept-language": "en-US" }, identity);
  const names = Object.keys(headers).map((name) => name.toLowerCase());
  assert.deepEqual(names.filter((name) => name === "sec-ch-ua"), ["sec-ch-ua"]);
  assert.deepEqual(names.filter((name) => name === "accept-language"), ["accept-language"]);
  assert.equal(headers["Sec-CH-UA"], '"Chromium";v="150", "Google Chrome";v="150", "Not?A_Brand";v="24"');
});

test("a high-entropy hint goes out only where the site asked for it", () => {
  const unasked = chromeHeaders("https://example.com/", {}, identity);
  assert.equal(unasked["Sec-CH-UA-Full-Version-List"], undefined);
  const asked = chromeHeaders("https://example.com/", { "Sec-CH-UA-Full-Version-List": '"Chromium";v="150.0.7871.224"' }, identity);
  assert.equal(
    asked["Sec-CH-UA-Full-Version-List"],
    '"Chromium";v="150.0.7871.224", "Google Chrome";v="150.0.7871.224", "Not?A_Brand";v="24.0.0.0"',
  );
});

test("http carries no client hints, the way Chrome sends none", () => {
  const headers = chromeHeaders("http://127.0.0.1:8080/", {}, identity);
  assert.equal(headers["Sec-CH-UA"], undefined);
  assert.equal(headers["Accept-Language"], "en-US,en;q=0.9");
});
