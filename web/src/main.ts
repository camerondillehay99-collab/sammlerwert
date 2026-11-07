import { h, svg, icons } from "./lib/dom.ts";
import { logoMark, wordmark } from "./lib/logo.ts";
import { modal } from "./components/ui.ts";
import { route, startRouter, navigate, render } from "./lib/router.ts";
import { state, subscribe, loadUser, setTheme, hydrateUser, setUser } from "./lib/store.ts";
import { api, invalidate, setUnauthorizedHandler } from "./lib/api.ts";
import { dashboard } from "./views/dashboard.ts";
import { search } from "./views/search.ts";
import { salesView } from "./views/sales.ts";
import { cardView } from "./views/card.ts";
import { collection } from "./views/collection.ts";
import { sets, setView } from "./views/sets.ts";
import { market, settings, pricing, legal, methodik, watchlistView } from "./views/misc.ts";
import { authView, mfaSetupView, mfaVerifyView } from "./views/auth.ts";
import { scanView } from "./views/scan.ts";
import { importView } from "./views/import.ts";
import { sharedView } from "./views/share.ts";
import { tr, initI18n, onLangChange } from "./lib/i18n.ts";

const BRAND = (document.querySelector('meta[name="application-name"]') as HTMLMetaElement | null)?.content ?? "Sammlerwert";
document.documentElement.dataset.theme = state.theme;

route("/", dashboard, () => tr("{BRAND} – Portfolio", { BRAND }));
route("/suche", search, () => tr("Suche – {BRAND}", { BRAND }));
route("/scan", scanView, () => tr("Scanner – {BRAND}", { BRAND }));
route("/karte/:id", cardView, () => BRAND, (p) => { api.card(p.id!).catch(() => {}); });
route("/sammlung", collection, () => tr("Meine Sammlung – {BRAND}", { BRAND }));
route("/sets", sets, () => tr("Sets – {BRAND}", { BRAND }), () => { api.sets().catch(() => {}); });
route("/sets/:id", setView, () => BRAND, (p, q) => { api.set(p.id!, q.get("sort") ?? "number").catch(() => {}); });
route("/verkaeufe", salesView, () => tr("Verkäufe – {BRAND}", { BRAND }), (_p, q) => { api.salesFeed({ limit: 50, q: q.get("q"), card: q.get("card"), grader: q.get("grader"), grade: q.get("grade") }).catch(() => {}); });
route("/markt", market, () => tr("Markt – {BRAND}", { BRAND }), (_p, q) => { api.movers(q.get("lang") === "en" ? "en" : "de").catch(() => {}); });
route("/login", authView("login"), () => tr("Anmelden – {BRAND}", { BRAND }));
route("/registrieren", authView("register"), () => tr("Registrieren – {BRAND}", { BRAND }));
route("/2fa", mfaVerifyView, () => tr("Code eingeben – {BRAND}", { BRAND }));
route("/2fa/einrichten", mfaSetupView, () => tr("Konto absichern – {BRAND}", { BRAND }));
route("/import", importView, () => tr("Import – {BRAND}", { BRAND }));
route("/watchlist", watchlistView, () => tr("Watchlist – {BRAND}", { BRAND }));
route("/s/:token", sharedView, () => tr("Geteilte Sammlung – {BRAND}", { BRAND }));
route("/einstellungen", settings, () => tr("Einstellungen – {BRAND}", { BRAND }));
route("/tarife", pricing, () => tr("Tarife – {BRAND}", { BRAND }));
route("/methodik", methodik, () => tr("Methodik – {BRAND}", { BRAND }));
route("/impressum", legal("impressum"), () => tr("Impressum – {BRAND}", { BRAND }));
route("/datenschutz", legal("datenschutz"), () => tr("Datenschutz – {BRAND}", { BRAND }));

interface NavItem { href: string; icon: string; label: string; match: (p: string) => boolean; hero?: boolean; desktop?: boolean; mobile?: boolean }
/** Desktop sidebar and the phone tab bar share one list; the scanner is a phone feature (camera), Sets & Markt move to "Mehr" on the phone. */
const NAV: NavItem[] = [
  { href: "/", icon: icons.home, label: "Portfolio", match: (p) => p === "/", desktop: true, mobile: true },
  { href: "/sammlung", icon: icons.cards, label: "Sammlung", match: (p) => p.startsWith("/sammlung"), desktop: true, mobile: true },
  { href: "/scan", icon: icons.camera, label: "Scannen", match: (p) => p.startsWith("/scan"), hero: true, mobile: true },
  { href: "/suche", icon: icons.search, label: "Suche", match: (p) => p.startsWith("/suche") || p.startsWith("/karte"), desktop: true, mobile: true },
  { href: "/sets", icon: icons.sets, label: "Sets", match: (p) => p.startsWith("/sets"), desktop: true },
  { href: "/verkaeufe", icon: icons.flag, label: "Verkäufe", match: (p) => p.startsWith("/verkaeufe"), desktop: true },
  { href: "/markt", icon: icons.market, label: "Markt", match: (p) => p.startsWith("/markt"), desktop: true },
  { href: "/import", icon: icons.download, label: "Import", match: (p) => p.startsWith("/import"), desktop: true },
];
const MORE: Array<{ href: string; icon: string; label: string; sub: string }> = [
  { href: "/sets", icon: icons.sets, label: "Sets", sub: "Alle Erweiterungen, Fortschritt" },
  { href: "/verkaeufe", icon: icons.flag, label: "Verkäufe", sub: "Letzte Verkäufe mit Note, Verkaufsart, Preis" },
  { href: "/markt", icon: icons.market, label: "Markt", sub: "Auf- und Absteiger" },
  { href: "/import", icon: icons.download, label: "Import", sub: "Collectr, Card Ladder, CSV, PSA" },
  { href: "/watchlist", icon: icons.eye, label: "Watchlist", sub: "Beobachtete Karten" },
  { href: "/einstellungen", icon: icons.settings, label: "Einstellungen", sub: "Konto, Sicherheit, Abo" },
  { href: "/methodik", icon: icons.info, label: "Methodik", sub: "So entsteht ein Wert" },
];

function navLinks(cls: string, where: "desktop" | "mobile") {
  return NAV.filter((n) => n[where]).map((n) => h("a", { class: `${cls}${n.hero ? " hero" : ""}`, href: n.href, dataset: { nav: n.href } }, svg(n.icon, 20), h("span", null, tr(n.label))));
}

function moreButton(): HTMLElement {
  const b = h("button", { class: "mnav-item", dataset: { nav: "more" }, "aria-label": tr("Mehr"), onClick: () => openMore() }, svg(icons.more, 20), h("span", null, tr("Mehr")));
  return b;
}

function openMore() {
  const body = h("div", { class: "more-grid" }, ...MORE.map((m) => h("a", { class: "more-item", href: m.href }, svg(m.icon, 22), h("span", null, h("strong", null, tr(m.label)), h("small", null, tr(m.sub))))));
  const foot = h("div", { class: "more-foot" },
    h("button", { class: "btn ghost sm", onClick: () => setTheme(state.theme === "dark" ? "light" : "dark") }, svg(state.theme === "dark" ? icons.sun : icons.moon, 16), state.theme === "dark" ? tr(" Hell") : tr(" Dunkel")),
    h("a", { class: "btn ghost sm", href: "/tarife" }, tr("Tarife")),
    state.user ? null : h("a", { class: "btn primary sm", href: "/login" }, tr("Anmelden")));
  const close = modal(tr("Mehr"), h("div", null, body, foot));
  body.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("a")) close(); });
  foot.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("a")) close(); });
}

function shell(): HTMLElement {
  const sidebar = h("aside", { class: "sidebar" },
    h("a", { class: "brand", href: "/" }, logoMark(36), h("span", null, wordmark(BRAND), h("small", null, tr("Deutsche Karten. Echte Preise.")))),
    h("nav", { class: "nav" }, ...navLinks("nav-item", "desktop")),
    h("div", { class: "sidebar-foot" }, userBox(), h("p", { class: "foot-links" }, h("a", { href: "/tarife" }, tr("Tarife")), " · ", h("a", { href: "/methodik" }, tr("Methodik")), " · ", h("a", { href: "/impressum" }, tr("Impressum")), " · ", h("a", { href: "/datenschutz" }, tr("Datenschutz")))),
  );
  const mobile = h("nav", { class: "mobile-nav" }, ...navLinks("mnav-item", "mobile"), moreButton());
  const main = h("main", { class: "main", id: "outlet" });
  const topbar = h("header", { class: "topbar" }, h("a", { class: "brand", href: "/" }, logoMark(30), wordmark(BRAND)), h("div", { class: "topbar-actions" }, themeBtn(), userMini()));
  return h("div", { class: "shell" }, sidebar, h("div", { class: "content" }, topbar, main), mobile, h("div", { class: "toast", id: "toast", role: "status", "aria-live": "polite" }));
}

function themeBtn() {
  const b = h("button", { class: "icon-btn", "aria-label": tr("Design wechseln"), onClick: () => setTheme(state.theme === "dark" ? "light" : "dark") });
  const draw = () => b.replaceChildren(svg(state.theme === "dark" ? icons.sun : icons.moon, 18));
  draw(); subscribe(draw); return b;
}

function userBox(): HTMLElement {
  const box = h("div", { class: "userbox" });
  const draw = () => box.replaceChildren(state.user
    ? h("a", { class: "userlink", href: "/einstellungen" }, h("span", { class: "avatar" }, (state.user.name ?? state.user.email).slice(0, 1).toUpperCase()), h("span", null, h("strong", null, state.user.name ?? state.user.email.split("@")[0]), h("small", null, { free: tr("Kostenlos"), sammler: tr("Sammler"), pro: tr("Pro") }[state.user.plan] ?? state.user.plan)), svg(icons.settings, 16))
    : h("div", { class: "auth-links" }, h("a", { class: "btn primary full", href: "/registrieren" }, tr("Kostenlos starten")), h("a", { class: "link center", href: "/login" }, tr("Anmelden"))));
  draw(); subscribe(draw); return box;
}

function userMini(): HTMLElement {
  const el = h("span");
  const draw = () => el.replaceChildren(state.user ? h("a", { class: "avatar", href: "/einstellungen", "aria-label": tr("Konto") }, (state.user.name ?? state.user.email).slice(0, 1).toUpperCase()) : h("a", { class: "btn primary sm", href: "/login" }, tr("Anmelden")));
  draw(); subscribe(draw); return el;
}

async function boot() {
  // Paint immediately with the last known user (if any); /api/auth/me confirms in the background and re-renders on change.
  const hydrated = hydrateUser();
  await initI18n(state.user?.locale ?? null);
  document.body.replaceChildren(shell());
  onLangChange(() => { document.body.replaceChildren(shell()); invalidate(); render(); });
  const userLoad = loadUser();
  if (!hydrated) await userLoad;
  else userLoad.then(() => { if (!state.user && !state.mfa) { invalidate(); render(); } });
  setUnauthorizedHandler(() => { if (state.user) { setUser(null); invalidate(); navigate(`/login?next=${encodeURIComponent(location.pathname)}`); } });
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
