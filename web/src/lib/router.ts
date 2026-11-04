// History-API router. Views are functions (params, query) → HTMLElement | Promise<HTMLElement>.
export type View = (params: Record<string, string>, query: URLSearchParams) => HTMLElement | Promise<HTMLElement>;
interface Route { re: RegExp; keys: string[]; view: View; title?: string }
const routes: Route[] = [];
let outlet: HTMLElement;
let onNavigate: ((path: string) => void) | null = null;

export function route(pattern: string, view: View, title?: string) {
  const keys: string[] = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
  routes.push({ re, keys, view, title });
}

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, "", path); else history.pushState(null, "", path);
  render();
}

export function currentPath() { return location.pathname + location.search; }

let seq = 0;
export async function render() {
  const my = ++seq;
  const path = location.pathname;
  const query = new URLSearchParams(location.search);
  for (const r of routes) {
    const m = path.match(r.re);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
    outlet.setAttribute("aria-busy", "true");
    try {
      const view = await r.view(params, query);
      if (my !== seq) return; // superseded by a newer navigation
      outlet.replaceChildren(view);
      if (r.title) document.title = r.title;
    } catch (e) {
      if (my !== seq) return;
      const err = document.createElement("div"); err.className = "empty";
      err.innerHTML = `<h2>Da ist etwas schiefgelaufen</h2><p>${(e as Error).message}</p>`;
      outlet.replaceChildren(err);
    } finally { outlet.removeAttribute("aria-busy"); }
    onNavigate?.(path);
    window.scrollTo({ top: 0 });
    return;
  }
  navigate("/", true);
}

export function startRouter(target: HTMLElement, cb: (path: string) => void) {
  outlet = target; onNavigate = cb;
  window.addEventListener("popstate", render);
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a || a.target === "_blank" || a.hasAttribute("download") || a.origin !== location.origin || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    navigate(a.pathname + a.search);
  });
  render();
}
