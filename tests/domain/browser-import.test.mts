import assert from "node:assert/strict";
import { test } from "vitest";
import { cookieOnSite, importSites, isBrowserImportMemory, isImportSite } from "../../src/domain/browser-import.ts";

test("subdomains fold into the site the profile also holds cookies for", () => {
  const sites = importSites([
    { host: "gist.github.com", cookies: 2 },
    { host: ".github.com", cookies: 3 },
    { host: "a.b.github.com", cookies: 1 },
    { host: "bbc.co.uk", cookies: 1 },
    { host: "news.bbc.co.uk", cookies: 1 },
    { host: "other.co.uk", cookies: 4 },
    { host: "only.sub.example.com", cookies: 1 },
  ]);

  assert.deepEqual(sites, [
    { domain: "bbc.co.uk", cookies: 2 },
    { domain: "github.com", cookies: 6 },
    { domain: "only.sub.example.com", cookies: 1 },
    { domain: "other.co.uk", cookies: 4 },
  ]);
});

test("a site takes its own cookies and its subdomains', never a lookalike's", () => {
  assert.equal(cookieOnSite(".github.com", "github.com"), true);
  assert.equal(cookieOnSite("api.github.com", "github.com"), true);
  assert.equal(cookieOnSite("notgithub.com", "github.com"), false);
  assert.equal(cookieOnSite("github.com.evil.io", "github.com"), false);
});

test("only plain host names can be asked for", () => {
  assert.equal(isImportSite("github.com"), true);
  assert.equal(isImportSite(".github.com"), false);
  assert.equal(isImportSite("github.com/path"), false);
  assert.equal(isImportSite(""), false);
  assert.equal(isBrowserImportMemory({ sourceId: "brave:0:Default", sites: ["github.com"] }), true);
  assert.equal(isBrowserImportMemory({ sourceId: "brave:0:Default", sites: [] }), false);
  assert.equal(isBrowserImportMemory({ sourceId: "brave:0:Default", sites: ["../x"] }), false);
});
