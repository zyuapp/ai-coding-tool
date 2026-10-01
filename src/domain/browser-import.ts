/** A browser profile on this machine whose sign-ins the browser panel can copy. */
export type BrowserImportSource = {
  /** Stable across reads, so a remembered import still names the same profile. */
  id: string;
  browser: string;
  profile: string;
};

/** A site that profile holds cookies for, with every subdomain folded into it. */
export type BrowserImportSite = {
  domain: string;
  cookies: number;
};

export type BrowserImportResult = {
  imported: number;
  /** Cookies the profile holds for those sites that could not be decrypted or set. */
  skipped: number;
};

/** The import the user last ran, which "Import again" repeats. */
export type BrowserImportMemory = {
  sourceId: string;
  sites: string[];
};

export const MAX_IMPORT_SITES = 500;

function hostName(host: string) {
  return host.replace(/^\./, "").toLowerCase();
}

/**
 * Folds cookie hosts into the sites a person recognises: a host joins the site of any parent host
 * the profile also holds cookies for. A cookie can never be set on a public suffix, so no unrelated
 * sites ever fold together.
 */
export function importSites(hosts: Array<{ host: string; cookies: number }>): BrowserImportSite[] {
  const names = hosts.map((entry) => ({ name: hostName(entry.host), cookies: entry.cookies })).filter((entry) => entry.name);
  names.sort((left, right) => left.name.split(".").length - right.name.split(".").length);
  const sites = new Map<string, number>();
  for (const { name, cookies } of names) {
    const labels = name.split(".");
    let parent = name;
    for (let index = 1; index < labels.length; index += 1) {
      const candidate = labels.slice(index).join(".");
      if (sites.has(candidate)) { parent = candidate; break; }
    }
    sites.set(parent, (sites.get(parent) ?? 0) + cookies);
  }
  return [...sites].map(([domain, cookies]) => ({ domain, cookies })).sort((left, right) => left.domain.localeCompare(right.domain));
}

/** Whether a cookie set for `host` belongs to `site`. */
export function cookieOnSite(host: string, site: string): boolean {
  const name = hostName(host);
  return name === site || name.endsWith(`.${site}`);
}

/** What a site name has to look like to be asked for. */
export function isImportSite(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 253 && /^[a-z0-9.-]+$/.test(value) && !value.startsWith(".");
}

export function isImportSourceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

export function isBrowserImportMemory(value: unknown): value is BrowserImportMemory {
  if (!value || typeof value !== "object") return false;
  const memory = value as Record<string, unknown>;
  return isImportSourceId(memory.sourceId) && Array.isArray(memory.sites) && memory.sites.length > 0
    && memory.sites.length <= MAX_IMPORT_SITES && memory.sites.every(isImportSite);
}
