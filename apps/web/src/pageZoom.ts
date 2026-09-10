/**
 * Gezoomt wird die Karte — nicht die App.
 *
 * Auf dem iPhone kippte bisher gelegentlich die ganze Oberfläche in den Zoom:
 * Zwei Finger, die neben dem Kartenbild aufsetzen — auf der Kopfzeile, dem
 * Kachelstreifen, einem offenen Blatt — sind für WebKit keine Kartengeste,
 * sondern eine Seitengeste. Danach steht die App vergrößert da, die Leisten
 * ragen aus dem Fenster, und zurück kommt man nur mit einer weiteren Geste.
 *
 * Über der Karte tritt das nicht auf: MapLibre setzt dort `touch-action: none`,
 * und die Karte hat den Zoom ohnehin selbst. Dieses Modul deckt den Rest ab.
 *
 * Zwei Wege, weil ein einzelner nicht überall greift:
 *
 *  - `user-scalable=no` in der Kopfzeile des Dokuments. Im installierten
 *    Web-App-Fenster hält sich iOS daran, im Browsertab ignoriert es die
 *    Angabe seit iOS 10 bewusst (Zugänglichkeit).
 *  - Die WebKit-eigenen `gesture*`-Ereignisse abfangen. Sie melden genau den
 *    Seitenzoom und sonst nichts; MapLibre arbeitet mit Berührungs-
 *    ereignissen und merkt davon nichts.
 *
 * Der Doppeltipp — die andere Art, versehentlich zu vergrößern — hängt am
 * `touch-action: manipulation` des Stylesheets.
 */

const GESTEN = ['gesturestart', 'gesturechange', 'gestureend'] as const;

/** Einmal beim Start aufrufen. Läuft für die Lebensdauer des Dokuments. */
export function lockPageZoom(): void {
  const abwehren = (e: Event) => e.preventDefault();
  for (const name of GESTEN) {
    document.addEventListener(name, abwehren, { passive: false });
  }
}
