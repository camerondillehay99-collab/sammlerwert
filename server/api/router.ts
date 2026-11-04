// Tiny route table shared by the API modules (routes.ts registers the core routes and imports the feature modules).
import type { SqlDb } from "../db/adapter.ts";

export type Handler = (req: Request, params: Record<string, string>, db: SqlDb) => Promise<Response> | Response;
export interface Route { method: string; pattern: string; handler: Handler; keys: string[]; re: RegExp }

const routes: Route[] = [];
export function add(method: string, pattern: string, handler: Handler) {
  const keys: string[] = [];
  const re = new RegExp("^" + pattern.replace(/\//g, "\\/").replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^\\/]+)"; }) + "\\/?$");
  routes.push({ method, pattern, handler, keys, re });
}

export function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.re);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
    return { route: r, params };
  }
  return null;
}

export function hasPath(pathname: string) { return routes.some((r) => r.re.test(pathname)); }
