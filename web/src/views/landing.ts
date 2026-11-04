import { h, svg, icons, fmt } from "../lib/dom.ts";
import { api } from "../lib/api.ts";

export function landing(): HTMLElement {
  const root = h("div", { class: "page landing" });
  const stats = h("div", { class: "landing-stats" });
  api.health().then((hlt) => {
    const s = hlt.stats;
    stats.append(
      h("div", null, h("b", null, fmt.int(Number(s.cards))), h("span", null, "Karten im Katalog")),
      h("div", null, h("b", null, fmt.int(Number(s.quotes))), h("span", null, "Marktwerte berechnet")),
      h("div", null, h("b", null, fmt.int(Number(s.sets))), h("span", null, "Sets, auf Deutsch")),
      h("div", null, h("b", null, s.guideDate ? fmt.date(String(s.guideDate)) : "–"), h("span", null, "letztes Preis-Update")),
    );
  }).catch(() => {});
  root.append(
    h("section", { class: "hero" },
      h("p", { class: "eyebrow" }, "Für deutsche Pokémon-Sammler"),
      h("h1", null, "Der Marktwert deiner ", h("em", null, "deutschen"), " Karten. Endlich richtig."),
      h("p", { class: "lead" }, "Collectr, Card Ladder & Co. kennen deutsche Karten kaum. Sammlerwert kombiniert den Cardmarket-Preisguide, echte Verkäufe deutscher Karten und Community-Meldungen zu einem sprachgenauen Marktwert – mit Konfidenz, Trend und voller Quellen-Transparenz."),
      h("div", { class: "hero-actions" }, h("a", { class: "btn primary lg", href: "/registrieren" }, "Kostenlos starten"), h("a", { class: "btn ghost lg", href: "/suche" }, svg(icons.search, 18), " Karte suchen")),
      stats,
    ),
    h("section", { class: "features" },
      feature(icons.flag, "Deutsch zuerst", "Suche nach „Glurak“, nicht „Charizard“. Deutsche Kartennamen, deutsche Sets, deutsche Preise – und jeder Wert sagt dir, ob er wirklich für die deutsche Version gilt."),
      feature(icons.shield, "Ehrliche Preise", "Jeder Marktwert kommt mit Konfidenz, Spanne und Methode. Wenig Daten? Sagen wir dir. Keine Fantasiezahlen."),
      feature(icons.market, "Verkäufe statt Angebote", "Aktive Angebote sind Wunschpreise. Wir gewichten tatsächliche Verkäufe – zeitlich abklingend, zustandsbereinigt, ausreißerfest."),
      feature(icons.cards, "Portfolio mit Historie", "Gesamtwert, Einstand, Gewinn/Verlust, Aufteilung nach Sprache und Set, tägliche Snapshots und Insights, die dir sagen, wo es sich lohnt hinzuschauen."),
      feature(icons.spark, "Schnell. Überall.", "Keine Werbung, kein Tracking, keine Ladebalken. Installierbar als App auf iPhone, Android und Desktop."),
      feature(icons.star, "Community-Daten", "Melde Verkäufe und mache die deutsche Datenbasis für alle besser – gewichtet, geprüft, transparent."),
    ),
    h("section", { class: "cta" }, h("h2", null, "Bereit?"), h("p", null, "Bis zu 50 Karten kostenlos. Kein Abo nötig, um zu starten."), h("a", { class: "btn primary lg", href: "/registrieren" }, "Konto erstellen")),
  );
  return root;
}

function feature(icon: string, title: string, text: string) {
  return h("div", { class: "feature" }, h("div", { class: "feature-icon" }, svg(icon, 22)), h("h3", null, title), h("p", null, text));
}
