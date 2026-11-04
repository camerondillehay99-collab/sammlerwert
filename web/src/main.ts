import { h, svg, icons } from "./lib/dom.ts";
import { modal } from "./components/ui.ts";
import { route, startRouter, navigate } from "./lib/router.ts";
import { state, subscribe, loadUser, setTheme } from "./lib/store.ts";
import { dashboard } from "./views/dashboard.ts";
import { search } from "./views/search.ts";
import { cardView } from "./views/card.ts";
import { collection } from "./views/collection.ts";
import { sets, setView } from "./views/sets.ts";
import { market, settings, pricing, legal, methodik, watchlistView } from "./views/misc.ts";
import { authView, mfaSetupView, mfaVerifyView } from "./views/auth.ts";
import { scanView } from "./views/scan.ts";
import { importView } from "./views/import.ts";
import { sharedView } from "./views/share.ts";

const BRAND = (document.querySelector('meta[name="application-name"]') as HTMLMetaElement | null)?.content ?? "Sammlerwert";
document.documentElement.dataset.theme = state.theme;

route("/", dashboard, `${BRAND} – Portfolio`);
route("/suche", search, `Suche – ${BRAND}`);
route("/scan", scanView, `Scanner – ${BRAND}`);
route("/karte/:id", cardView, BRAND);
route("/sammlung", collection, `Meine Sammlung – ${BRAND}`);
route("/sets", sets, `Sets – ${BRAND}`);
route("/sets/:id", setView, BRAND);
route("/markt", market, `Markt – ${BRAND}`);
route("/login", authView("login"), `Anmelden – ${BRAND}`);
route("/registrieren", authView("register"), `Registrieren – ${BRAND}`);
route("/2fa", mfaVerifyView, `Code eingeben – ${BRAND}`);
route("/2fa/einrichten", mfaSetupView, `Konto absichern – ${BRAND}`);
route("/import", importView, `Import – ${BRAND}`);
route("/watchlist", watchlistView, `Watchlist – ${BRAND}`);
route("/s/:token", sharedView, `Geteilte Sammlung – ${BRAND}`);
route("/einstellungen", settings, `Einstellungen – ${BRAND}`);
route("/tarife", pricing, `Tarife – ${BRAND}`);
route("/methodik", methodik, `Methodik – ${BRAND}`);
route("/impressum", legal("impressum"), `Impressum – ${BRAND}`);
route("/datenschutz", legal("datenschutz"), `Datenschutz – ${BRAND}`);

interface NavItem { href: string; icon: string; label: string; match: (p: string) => boolean; hero?: boolean; desktop?: boolean; mobile?: boolean }
/** Desktop sidebar and the phone tab bar share one list; the scanner is a phone feature (camera), Sets & Markt move to "Mehr" on the phone. */
const NAV: NavItem[] = [
  { href: "/", icon: icons.home, label: "Portfolio", match: (p) => p === "/", desktop: true, mobile: true },
  { href: "/sammlung", icon: icons.cards, label: "Sammlung", match: (p) => p.startsWith("/sammlung"), desktop: true, mobile: true },
  { href: "/scan", icon: icons.camera, label: "Scannen", match: (p) => p.startsWith("/scan"), hero: true, mobile: true },
  { href: "/suche", icon: icons.search, label: "Suche", match: (p) => p.startsWith("/suche") || p.startsWith("/karte"), desktop: true, mobile: true },
  { href: "/sets", icon: icons.sets, label: "Sets", match: (p) => p.startsWith("/sets"), desktop: true },
  { href: "/markt", icon: icons.market, label: "Markt", match: (p) => p.startsWith("/markt"), desktop: true },
  { href: "/import", icon: icons.download, label: "Import", match: (p) => p.startsWith("/import"), desktop: true },
];
const MORE: Array<{ href: string; icon: string; label: string; sub: string }> = [
  { href: "/sets", icon: icons.sets, label: "Sets", sub: "Alle Erweiterungen, Fortschritt" },
  { href: "/markt", icon: icons.market, label: "Markt", sub: "Auf- und Absteiger" },
  { href: "/import", icon: icons.download, label: "Import", sub: "Collectr, Card Ladder, CSV, PSA" },
  { href: "/watchlist", icon: icons.eye, label: "Watchlist", sub: "Beobachtete Karten" },
  { href: "/einstellungen", icon: icons.settings, label: "Einstellungen", sub: "Konto, Sicherheit, Abo" },
  { href: "/methodik", icon: icons.info, label: "Methodik", sub: "So entsteht ein Wert" },
];

function navLinks(cls: string, where: "desktop" | "mobile") {
  return NAV.filter((n) => n[where]).map((n) => h("a", { class: `${cls}${n.hero ? " hero" : ""}`, href: n.href, dataset: { nav: n.href } }, svg(n.icon, 20), h("span", null, n.label)));
}

function moreButton(): HTMLElement {
  const b = h("button", { class: "mnav-item", dataset: { nav: "more" }, "aria-label": "Mehr", onClick: () => openMore() }, svg(icons.more, 20), h("span", null, "Mehr"));
  return b;
}

function openMore() {
  const body = h("div", { class: "more-grid" }, ...MORE.map((m) => h("a", { class: "more-item", href: m.href }, svg(m.icon, 22), h("span", null, h("strong", null, m.label), h("small", null, m.sub)))));
  const foot = h("div", { class: "more-foot" },
    h("button", { class: "btn ghost sm", onClick: () => setTheme(state.theme === "dark" ? "light" : "dark") }, svg(state.theme === "dark" ? icons.sun : icons.moon, 16), state.theme === "dark" ? " Hell" : " Dunkel"),
    h("a", { class: "btn ghost sm", href: "/tarife" }, "Tarife"),
    state.user ? null : h("a", { class: "btn primary sm", href: "/login" }, "Anmelden"));
  const close = modal("Mehr", h("div", null, body, foot));
  body.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("a")) close(); });
  foot.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("a")) close(); });
}

function shell(): HTMLElement {
  const sidebar = h("aside", { class: "sidebar" },
    h("a", { class: "brand", href: "/" }, h("span", { class: "brand-mark" }, "S"), h("span", null, h("strong", null, BRAND), h("small", null, "Deutsche Karten. Echte Preise."))),
    h("nav", { class: "nav" }, ...navLinks("nav-item", "desktop")),
    h("div", { class: "sidebar-foot" }, userBox(), h("p", { class: "foot-links" }, h("a", { href: "/tarife" }, "Tarife"), " · ", h("a", { href: "/methodik" }, "Methodik"), " · ", h("a", { href: "/impressum" }, "Impressum"), " · ", h("a", { href: "/datenschutz" }, "Datenschutz"))),
  );
  const mobile = h("nav", { class: "mobile-nav" }, ...navLinks("mnav-item", "mobile"), moreButton());
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
    document.querySelectorAll<HTMLElement>("[data-nav]").forEach((a) => {
      const n = NAV.find((x) => x.href === a.dataset.nav);
      a.classList.toggle("active", n ? n.match(path) : MORE.some((m) => path.startsWith(m.href)));
    });
  }, (path) => {
    // A pending second factor owns the screen: everything except the 2FA pages and public pages goes there first.
    if (state.mfa && !/^\/(2fa|login|registrieren|impressum|datenschutz|methodik|tarife|s\/)/.test(path)) return state.mfa.step === "setup" ? "/2fa/einrichten" : "/2fa";
    return null;
  });
  subscribe(() => { /* re-render current view on login/logout */ });
  document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); navigate("/suche"); setTimeout(() => (document.querySelector(".search-input") as HTMLInputElement | null)?.focus(), 50); } });
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(() => {});
}
boot();
