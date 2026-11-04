// History-API router. Views are functions (params, query) → HTMLElement | Promise<HTMLElement>.
// Perceived speed: a slim progress bar for anything slower than 120 ms, a short enter transition for new
// views, and link prefetching on hover (desktop) / touchstart (mobile) so the data is usually already there.
export type View = (params: Record<string, string>, query: URLSearchParams) => HTMLElement | Promise<HTMLElement>;
export type Prefetch = (params: Record<string, string>, query: URLSearchParams) => void;
interface Route { re: RegExp; keys: string[]; view: View; title?: string | (() => string); prefetch?: Prefetch }
const routes: Route[] = [];
let outlet: HTMLElement;
let onNavigate: ((path: string) => void) | null = null;
let guard: ((path: string) => string | null) | null = null;

export function route(pattern: string, view: View, title?: string | (() => string), prefetch?: Prefetch) {
  const keys: string[] = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
  routes.push({ re, keys, view, title, prefetch });
}

function match(path: string): { r: Route; params: Record<string, string> } | null {
  for (const r of routes) {
    const m = path.match(r.re);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
    return { r, params };
  }
  return null;
}

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, "", path); else history.pushState(null, "", path);
  render();
}

export function currentPath() { return location.pathname + location.search; }

// ---- progress bar -------------------------------------------------------------------------------
let bar: HTMLElement | null = null, barTimer: ReturnType<typeof setTimeout> | null = null;
function progressStart() {
  if (barTimer) clearTimeout(barTimer);
  barTimer = setTimeout(() => {
    if (!bar) { bar = document.createElement("div"); bar.className = "nav-progress"; bar.setAttribute("aria-hidden", "true"); document.body.append(bar); }
    bar.classList.remove("done"); bar.classList.add("on");
  }, 120);
}
function progressDone() {
  if (barTimer) { clearTimeout(barTimer); barTimer = null; }
  if (bar?.classList.contains("on")) { bar.classList.add("done"); setTimeout(() => bar?.classList.remove("on", "done"), 320); }
}

let seq = 0;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
export async function render() {
  const my = ++seq;
  const path = location.pathname;
  const redirect = guard?.(path);
  if (redirect && redirect !== path) { history.replaceState(null, "", redirect); seq--; return render(); }
  const query = new URLSearchParams(location.search);
  const hit = match(path);
  if (!hit) { navigate("/", true); return; }
  outlet.setAttribute("aria-busy", "true");
  progressStart();
  try {
    const view = await hit.r.view(hit.params, query);
    if (my !== seq) return; // superseded by a newer navigation
    if (!reduced()) view.classList.add("view-enter");
    outlet.replaceChildren(view);
    if (hit.r.title) document.title = typeof hit.r.title === "function" ? hit.r.title() : hit.r.title;
  } catch (e) {
    if (my !== seq) return;
    const err = document.createElement("div"); err.className = "empty";
    err.innerHTML = `<h2>Da ist etwas schiefgelaufen</h2><p>${(e as Error).message}</p>`;
    outlet.replaceChildren(err);
  } finally { if (my === seq) { outlet.removeAttribute("aria-busy"); progressDone(); } }
  onNavigate?.(path);
  window.scrollTo({ top: 0 });
}

// ---- prefetch -----------------------------------------------------------------------------------
const prefetched = new Set<string>();
export function prefetch(href: string) {
  try {
    const u = new URL(href, location.origin);
    if (u.origin !== location.origin || prefetched.has(u.pathname + u.search)) return;
    const hit = match(u.pathname);
    if (!hit?.r.prefetch) return;
    prefetched.add(u.pathname + u.search);
    hit.r.prefetch(hit.params, u.searchParams);
    if (prefetched.size > 300) prefetched.clear();
  } catch { /* ignore */ }
}

/** `guardFn` runs before every render and may return a path to go to instead (e.g. a pending second factor). */
export function startRouter(target: HTMLElement, cb: (path: string) => void, guardFn?: (path: string) => string | null) {
  outlet = target; onNavigate = cb; guard = guardFn ?? null;
  window.addEventListener("popstate", render);
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a || a.target === "_blank" || a.hasAttribute("download") || a.origin !== location.origin || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    navigate(a.pathname + a.search);
  });
  const warm = (e: Event) => { const a = (e.target as HTMLElement).closest?.("a[href]"); if (a) prefetch((a as HTMLAnchorElement).href); };
  document.addEventListener("pointerover", warm, { passive: true });
  document.addEventListener("touchstart", warm, { passive: true });
  document.addEventListener("focusin", warm);
  render();
}
