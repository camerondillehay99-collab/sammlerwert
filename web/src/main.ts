import { h, svg, icons } from "./lib/dom.ts";
import { route, startRouter, navigate } from "./lib/router.ts";
import { state, subscribe, loadUser, setTheme } from "./lib/store.ts";
import { dashboard } from "./views/dashboard.ts";
import { search } from "./views/search.ts";
import { cardView } from "./views/card.ts";
import { collection } from "./views/collection.ts";
import { sets, setView } from "./views/sets.ts";
import { market, authView, settings, pricing, legal, methodik } from "./views/misc.ts";

const BRAND = (document.querySelector('meta[name="application-name"]') as HTMLMetaElement | null)?.content ?? "Sammlerwert";
document.documentElement.dataset.theme = state.theme;

route("/", dashboard, `${BRAND} – Portfolio`);
route("/suche", search, `Suche – ${BRAND}`);
route("/karte/:id", cardView, BRAND);
route("/sammlung", collection, `Meine Sammlung – ${BRAND}`);
route("/sets", sets, `Sets – ${BRAND}`);
route("/sets/:id", setView, BRAND);
route("/markt", market, `Markt – ${BRAND}`);
route("/login", authView("login"), `Anmelden – ${BRAND}`);
route("/registrieren", authView("register"), `Registrieren – ${BRAND}`);
route("/einstellungen", settings, `Einstellungen – ${BRAND}`);
route("/tarife", pricing, `Tarife – ${BRAND}`);
route("/methodik", methodik, `Methodik – ${BRAND}`);
route("/impressum", legal("impressum"), `Impressum – ${BRAND}`);
route("/datenschutz", legal("datenschutz"), `Datenschutz – ${BRAND}`);

const NAV = [
  { href: "/", icon: icons.home, label: "Portfolio", match: (p: string) => p === "/" },
  { href: "/sammlung", icon: icons.cards, label: "Sammlung", match: (p: string) => p.startsWith("/sammlung") },
  { href: "/suche", icon: icons.search, label: "Suche", match: (p: string) => p.startsWith("/suche") || p.startsWith("/karte") },
  { href: "/sets", icon: icons.sets, label: "Sets", match: (p: string) => p.startsWith("/sets") },
  { href: "/markt", icon: icons.market, label: "Markt", match: (p: string) => p.startsWith("/markt") },
];

function navLinks(cls: string) {
  return NAV.map((n) => h("a", { class: cls, href: n.href, dataset: { nav: n.href } }, svg(n.icon, 20), h("span", null, n.label)));
}

function shell(): HTMLElement {
  const sidebar = h("aside", { class: "sidebar" },
    h("a", { class: "brand", href: "/" }, h("span", { class: "brand-mark" }, "S"), h("span", null, h("strong", null, BRAND), h("small", null, "Deutsche Karten. Echte Preise."))),
    h("nav", { class: "nav" }, ...navLinks("nav-item")),
    h("div", { class: "sidebar-foot" }, userBox(), h("p", { class: "foot-links" }, h("a", { href: "/tarife" }, "Tarife"), " · ", h("a", { href: "/methodik" }, "Methodik"), " · ", h("a", { href: "/impressum" }, "Impressum"), " · ", h("a", { href: "/datenschutz" }, "Datenschutz"))),
  );
  const mobile = h("nav", { class: "mobile-nav" }, ...navLinks("mnav-item"));
  const main = h("main", { class: "main", id: "outlet" });
  const topbar = h("header", { class: "topbar" }, h("a", { class: "brand", href: "/" }, h("span", { class: "brand-mark" }, "S"), h("strong", null, BRAND)), h("div", { class: "topbar-actions" }, themeBtn(), userMini()));
  return h("div", { class: "shell" }, sidebar, h("div", { class: "content" }, topbar, main), mobile, h("div", { class: "toast", id: "toast", role: "status", "aria-live": "polite" }));
}

function themeBtn() {
  const b = h("button", { class: "icon-btn", "aria-label": "Design wechseln", onClick: () => setTheme(state.theme === "dark" ? "light" : "dark") });
  const draw = () => b.replaceChildren(svg(state.theme === "dark" ? icons.sun : icons.moon, 18));
  draw(); subscribe(draw); return b;
}

function userBox(): HTMLElement {
  const box = h("div", { class: "userbox" });
  const draw = () => box.replaceChildren(state.user
    ? h("a", { class: "userlink", href: "/einstellungen" }, h("span", { class: "avatar" }, (state.user.name ?? state.user.email).slice(0, 1).toUpperCase()), h("span", null, h("strong", null, state.user.name ?? state.user.email.split("@")[0]), h("small", null, { free: "Kostenlos", sammler: "Sammler", pro: "Pro" }[state.user.plan] ?? state.user.plan)), svg(icons.settings, 16))
    : h("div", { class: "auth-links" }, h("a", { class: "btn primary full", href: "/registrieren" }, "Kostenlos starten"), h("a", { class: "link center", href: "/login" }, "Anmelden")));
  draw(); subscribe(draw); return box;
}

function userMini(): HTMLElement {
  const el = h("span");
  const draw = () => el.replaceChildren(state.user ? h("a", { class: "avatar", href: "/einstellungen", "aria-label": "Konto" }, (state.user.name ?? state.user.email).slice(0, 1).toUpperCase()) : h("a", { class: "btn primary sm", href: "/login" }, "Anmelden"));
  draw(); subscribe(draw); return el;
}

async function boot() {
  await loadUser();
  document.body.replaceChildren(shell());
  startRouter(document.getElementById("outlet")!, (path) => {
    document.querySelectorAll<HTMLElement>("[data-nav]").forEach((a) => a.classList.toggle("active", NAV.find((n) => n.href === a.dataset.nav)!.match(path)));
  });
  subscribe(() => { /* re-render current view on login/logout */ });
  document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); navigate("/suche"); setTimeout(() => (document.querySelector(".search-input") as HTMLInputElement | null)?.focus(), 50); } });
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(() => {});
}
boot();
