const DROP = new Set([
  "sid",
  "session",
  "sessionid",
  "phpsessid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
]);

export function canonicalUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";

  for (const key of [...u.searchParams.keys()]) {
    if (DROP.has(key.toLowerCase())) {
      u.searchParams.delete(key);
    }
  }

  if (u.pathname.length > 1) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }

  return u.toString();
}