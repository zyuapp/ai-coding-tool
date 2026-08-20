/**
 * How the panel presents itself to a site. Electron's own headers contradict each other: the user
 * agent names Electron, and replacing only that string leaves `Sec-CH-UA` announcing Chromium at a
 * different version with no Google Chrome brand, which is a pair no real browser sends.
 */
export type ChromeIdentity = {
  userAgent: string;
  acceptLanguage: string;
  hints: Record<string, string>;
};

/** The hints Chrome puts on every secure request. The rest go out only where a site asked for them. */
const LOW_ENTROPY = new Set(["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"]);

const GREASE = "Not?A_Brand";

/** The Chrome this build actually is, so nothing here drifts as Electron moves. */
export function chromeIdentity(chromeVersion: string): ChromeIdentity {
  const major = chromeVersion.split(".")[0] ?? chromeVersion;
  const brands = (version: string, grease: string) =>
    `"Chromium";v="${version}", "Google Chrome";v="${version}", "${GREASE}";v="${grease}"`;
  return {
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    acceptLanguage: "en-US,en;q=0.9",
    hints: {
      "Sec-CH-UA": brands(major, "24"),
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"macOS"',
      "Sec-CH-UA-Full-Version-List": brands(chromeVersion, "24.0.0.0"),
    },
  };
}

function drop(headers: Record<string, string>, name: string) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === lower) delete headers[key];
}

function has(headers: Record<string, string>, name: string) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function set(headers: Record<string, string>, name: string, value: string) {
  drop(headers, name);
  headers[name] = value;
}

/** Client hints ride secure requests only, so http keeps whatever Chromium decided to send. */
function secure(url: string) {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** The request as this identity would make it: hints that agree with the user agent, and its language. */
export function chromeHeaders(url: string, requestHeaders: Record<string, string>, identity: ChromeIdentity) {
  const headers = { ...requestHeaders };
  set(headers, "Accept-Language", identity.acceptLanguage);
  if (!secure(url)) return headers;
  for (const [name, value] of Object.entries(identity.hints)) {
    if (LOW_ENTROPY.has(name.toLowerCase()) || has(headers, name)) set(headers, name, value);
  }
  return headers;
}
