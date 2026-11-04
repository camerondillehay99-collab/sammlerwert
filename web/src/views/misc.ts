// Market, auth, settings, pricing pages.
import { h, svg, icons, fmt, label, toast, cardName } from "../lib/dom.ts";
import { api, HttpError, invalidate } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { state, setUser, setTheme } from "../lib/store.ts";
import { cardTile, empty, field, section } from "../components/ui.ts";

export async function market(_p: Record<string, string>, query: URLSearchParams): Promise<HTMLElement> {
  const lang = query.get("lang") === "en" ? "en" : "de";
  const [m, hlt] = await Promise.all([api.movers(lang), api.health()]);
  const seg = h("div", { class: "seg" }, ...[["de", "Deutsch"], ["en", "Englisch"]].map(([v, t]) => h("a", { class: v === lang ? "active" : "", href: `/markt?lang=${v}` }, t)));
  return h("div", { class: "page" },
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, "Markt"), h("h1", null, "Bewegungen der letzten 30 Tage")), seg),
    h("p", { class: "muted" }, `Datenstand Cardmarket-Preisguide: ${hlt.stats.guideDate ? fmt.date(String(hlt.stats.guideDate)) : "–"} · ${fmt.int(Number(hlt.stats.quotes))} bewertete Karten-Varianten · Trends basieren bis zum Aufbau der eigenen Historie auf Cardmarkts 30-Tage-Durchschnitt.`),
    section("Aufsteiger", m.up.length ? h("div", { class: "tiles" }, ...m.up.map((x) => cardTile(x.card, { value: x.value, trend: x.trend }))) : empty("Noch keine Daten", "Trends erscheinen, sobald Preishistorie vorliegt.")),
    section("Absteiger", m.down.length ? h("div", { class: "tiles" }, ...m.down.map((x) => cardTile(x.card, { value: x.value, trend: x.trend }))) : empty("Noch keine Daten", "")),
  );
}

export function authView(mode: "login" | "register") {
  return (_p: Record<string, string>, query: URLSearchParams): HTMLElement => {
    const next = query.get("next") ?? "/";
    const email = h("input", { type: "email", name: "email", required: true, autocomplete: "email", placeholder: "du@beispiel.de" });
    const pw = h("input", { type: "password", name: "password", required: true, minlength: 8, autocomplete: mode === "login" ? "current-password" : "new-password", placeholder: mode === "login" ? "Passwort" : "Mindestens 8 Zeichen" });
    const name = h("input", { type: "text", name: "name", autocomplete: "nickname", placeholder: "Wie sollen wir dich nennen?" });
    const submit = h("button", { class: "btn primary lg full", type: "submit" }, mode === "login" ? "Anmelden" : "Konto erstellen");
    const form = h("form", { class: "form auth-form" },
      mode === "register" ? field("Name (optional)", name) : null, field("E-Mail", email), field("Passwort", pw), submit,
      h("p", { class: "muted center" }, mode === "login" ? ["Noch kein Konto? ", h("a", { href: `/registrieren?next=${encodeURIComponent(next)}` }, "Registrieren")] : ["Schon dabei? ", h("a", { href: `/login?next=${encodeURIComponent(next)}` }, "Anmelden")]));
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); submit.disabled = true;
      try {
        const r = mode === "login" ? await api.login(email.value, pw.value) : await api.register(email.value, pw.value, name.value);
        setUser(r.user); invalidate(); toast(mode === "login" ? "Willkommen zurück!" : "Willkommen bei Sammlerwert!"); navigate(next);
      } catch (err) { submit.disabled = false; toast((err as Error).message, "error"); }
    });
    return h("div", { class: "page narrow" }, h("header", { class: "page-head center" }, h("div", null, h("p", { class: "eyebrow" }, "Konto"), h("h1", null, mode === "login" ? "Anmelden" : "Kostenlos registrieren"),
      mode === "register" ? h("p", { class: "muted" }, "Bis zu 50 Karten kostenlos. Keine Zahlungsdaten nötig.") : null)), form);
  };
}

export async function settings(_p: Record<string, string>, query: URLSearchParams): Promise<HTMLElement> {
  if (!state.user) { navigate("/login?next=/einstellungen", true); return h("div"); }
  const u = state.user;
  if (query.get("checkout") === "success") { toast("Danke! Dein Abo wird aktiviert."); setTimeout(async () => { setUser((await api.me()).user); }, 1500); }
  const hlt = await api.health();
  const name = h("input", { value: u.name ?? "", placeholder: "Name" });
  const save = h("button", { class: "btn primary", onClick: async () => { setUser((await api.updateMe({ name: name.value })).user); toast("Gespeichert."); } }, "Speichern");
  const theme = h("div", { class: "seg" }, ...(["light", "dark"] as const).map((t) => h("button", { class: state.theme === t ? "active" : "", onClick: (e: Event) => { setTheme(t); (e.currentTarget as HTMLElement).parentElement!.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === e.currentTarget)); } }, svg(t === "light" ? icons.sun : icons.moon, 16), t === "light" ? " Hell" : " Dunkel")));
  const planNames: Record<string, string> = { free: "Kostenlos", sammler: "Sammler", pro: "Pro" };
  const billing = section("Abo",
    h("p", null, "Aktueller Tarif: ", h("b", null, planNames[u.plan] ?? u.plan), u.planStatus && u.plan !== "free" ? h("span", { class: "muted" }, ` (${u.planStatus})`) : null),
    h("div", { class: "actions-row" },
      u.plan === "free" ? h("a", { class: "btn primary", href: "/tarife" }, "Upgrade") : h("button", { class: "btn ghost", onClick: async () => { try { location.href = (await api.portal()).url; } catch (e) { toast((e as Error).message, "error"); } } }, "Abo verwalten"),
      !hlt.billing ? h("span", { class: "muted small" }, "Zahlungen sind in dieser Installation noch nicht aktiviert (Stripe-Schlüssel fehlen).") : null));
  const watch = section("Watchlist", await watchlist());
  const admin = (u as { isAdmin?: boolean }).isAdmin ? await adminPanel() : null;
  return h("div", { class: "page narrow" },
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, "Konto"), h("h1", null, "Einstellungen"))),
    section("Profil", h("div", { class: "row" }, field("Name", name), field("E-Mail", h("input", { value: u.email, disabled: true }))), h("div", { class: "actions-row" }, save)),
    section("Darstellung", theme),
    billing, watch, admin,
    section("Daten & Datenschutz", h("p", { class: "muted" }, "Deine Sammlung gehört dir. Export jederzeit als CSV (ab Sammler-Tarif). Keine Werbung, kein Tracking, Server in der EU."),
      h("div", { class: "actions-row" }, h("button", { class: "btn ghost", onClick: async () => { await api.logout(); setUser(null); invalidate(); navigate("/"); } }, svg(icons.logout, 16), " Abmelden"))),
  );
}

async function watchlist(): Promise<HTMLElement> {
  const w = await api.watchlist();
  if (!w.items.length) return h("p", { class: "muted" }, "Noch keine Karten auf der Watchlist. Auf jeder Kartenseite: „Beobachten“.");
  return h("ul", { class: "ranked" }, ...w.items.map((it) => h("li", null, h("a", { href: `/karte/${encodeURIComponent(it.cardId)}` }, `${cardName(it.card)} #${it.card.localId}`), h("span", { class: "muted" }, label.language(it.language)), h("b", null, fmt.eur(it.card.valueDe)),
    h("button", { class: "icon-btn", "aria-label": "Entfernen", onClick: async (e: Event) => { await api.unwatch(it.id); (e.currentTarget as HTMLElement).closest("li")!.remove(); } }, svg(icons.close, 16)))));
}

async function adminPanel(): Promise<HTMLElement> {
  const data = await api.jobs();
  const out = h("pre", { class: "log" }, JSON.stringify(data.stats, null, 1));
  const run = (job: string) => h("button", { class: "btn ghost", onClick: async (e: Event) => { const b = e.currentTarget as HTMLButtonElement; b.disabled = true; try { const r = await api.runJob(job); out.textContent = `${job}: ${r.detail}`; toast("Job ausgeführt."); } catch (err) { toast((err as Error).message, "error"); } b.disabled = false; } }, job);
  return section("Admin · Daten-Jobs", h("div", { class: "chips" }, run("daily_refresh"), run("catalog_completion"), run("reprice"), run("ebay_refresh"), run("snapshots")), out,
    h("details", null, h("summary", null, "Letzte Läufe"), h("ul", { class: "ranked" }, ...data.runs.slice(0, 15).map((r) => h("li", null, h("span", null, `${r.job}`), h("span", { class: "muted" }, String(r.started_at).slice(0, 16).replace("T", " ")), h("b", { class: r.status === "ok" ? "up" : r.status === "error" ? "down" : "" }, String(r.status)))))));
}

export function legal(kind: "impressum" | "datenschutz") {
  return (): HTMLElement => h("div", { class: "page narrow" },
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, "Rechtliches"), h("h1", null, kind === "impressum" ? "Impressum" : "Datenschutz"))),
    section(kind === "impressum" ? "Angaben gemäß § 5 DDG" : "Kurz gesagt",
      kind === "impressum"
        ? h("p", null, "[Name / Firma], [Straße Nr.], [PLZ] Berlin · E-Mail: [adresse] · USt-IdNr.: [falls vorhanden]. Verantwortlich für den Inhalt: [Name]. Plattform der EU-Kommission zur Online-Streitbeilegung: ec.europa.eu/consumers/odr. Pokémon und alle Kartennamen sind Marken ihrer jeweiligen Rechteinhaber; Sammlerwert ist ein unabhängiges, inoffizielles Angebot.")
        : h("div", { class: "form" },
            h("p", null, "Wir speichern nur, was für dein Konto und deine Sammlung nötig ist: E-Mail, Passwort-Hash (Argon2id), Sammlungsdaten, hochgeladene Bilder und gemeldete Verkäufe. Keine Werbenetzwerke, kein Tracking, keine Weitergabe."),
            h("p", null, "Server-Standort: EU. Zahlungsabwicklung: Stripe Payments Europe Ltd. (Kartendaten sehen wir nie). Kartenbilder werden von assets.tcgdex.net geladen; dabei wird deine IP-Adresse an diesen Dienst übertragen."),
            h("p", null, "Du kannst dein Konto jederzeit löschen lassen ([adresse]); Exporte gibt es unter Sammlung → CSV. Verantwortlicher im Sinne der DSGVO: siehe Impressum."))),
    h("p", { class: "muted small" }, "Platzhalter in eckigen Klammern vor dem Start ausfüllen – idealerweise mit einem Generator (z. B. e-recht24) oder Anwalt gegenprüfen."));
}

export async function pricing(): Promise<HTMLElement> {
  const hlt = await api.health();
  const plan = (name: string, price: string, items: string[], cta: HTMLElement, featured = false) => h("div", { class: `plan ${featured ? "featured" : ""}` }, h("h3", null, name), h("div", { class: "plan-price" }, price), h("ul", null, ...items.map((i) => h("li", null, svg(icons.check, 16), i))), cta);
  const buy = (p: "sammler" | "pro", text: string) => h("button", { class: "btn primary full", onClick: async () => {
    if (!state.user) return navigate(`/registrieren?next=/tarife`);
    try { location.href = (await api.checkout(p)).url; } catch (e) { toast(e instanceof HttpError && e.code === "billing_disabled" ? "Zahlungen sind noch nicht freigeschaltet – bald!" : (e as Error).message, "error"); }
  } }, text);
  return h("div", { class: "page" },
    h("header", { class: "page-head center" }, h("div", null, h("p", { class: "eyebrow" }, "Tarife"), h("h1", null, "Einfach. Fair. Jederzeit kündbar."), h("p", { class: "muted" }, "Preise inkl. MwSt. Monatlich kündbar.", !hlt.billing ? " Zahlungen werden in Kürze freigeschaltet." : ""))),
    h("div", { class: "plans" },
      plan("Kostenlos", "0 €", ["Bis zu 50 Karten", "Deutsche Marktwerte & Trends", "Suche, Sets, Markt", "Verkäufe melden"], state.user ? h("a", { class: "btn ghost full", href: "/sammlung" }, "Dein aktueller Start") : h("a", { class: "btn ghost full", href: "/registrieren" }, "Kostenlos starten")),
      plan("Sammler", "4,99 € / Monat", ["Bis zu 2.500 Karten", "Vollständige Wert-Historie", "Gewinn/Verlust & Insights", "25 Preisalarme", "CSV-Export"], buy("sammler", "Sammler werden"), true),
      plan("Pro", "9,99 € / Monat", ["Unbegrenzte Karten", "Mehrere Sammlungen", "Unbegrenzte Preisalarme", "Prioritäts-Aktualisierung deiner Karten", "Früher Zugang zu neuen Funktionen"], buy("pro", "Pro werden")),
    ),
    h("p", { class: "muted center small" }, "Händler-/API-Zugang auf Anfrage."));
}
