/**
 * What a request's URL looks like in the logs.
 *
 * Query values are dropped: the OAuth callback carries a live authorization
 * code and state there, and nothing in a query string is worth keeping in
 * Railway's logs. Keys stay for debugging. The account review link carries
 * its one-time token in the path (lib/accessReview.ts), so that segment is
 * dropped too.
 */
export function loggedUrl(url: string): string {
  const [rawPath, query] = url.split("?", 2);
  const path = rawPath.replace(/^\/*access-review\/[^/]*\/?$/, "/access-review/…");
  const keys = query
    ? [...new URLSearchParams(query).keys()].map((k) => `${k}=…`).join("&")
    : "";
  return keys ? `${path}?${keys}` : path;
}
