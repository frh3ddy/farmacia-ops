/** Route prefixes the api answers; everything else may be a web page. */
const API_PREFIXES = [
  "/api",
  "/admin",
  "/webhooks",
  "/locations",
  "/auth",
  "/employees",
  "/inventory",
  "/expenses",
  "/products",
  "/labor",
  "/yastas",
  "/transfers",
  "/internal",
];

/** True for a page load the web app routes: a GET outside the api, not a file. */
export function servesIndexHtml(method: string, path: string): boolean {
  if (method !== "GET") return false;
  const isApiRoute = API_PREFIXES.some((prefix) => path.startsWith(prefix));
  return !isApiRoute && path !== "/" && !path.includes(".");
}
