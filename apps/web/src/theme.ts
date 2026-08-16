/**
 * Hell oder dunkel — als Einstellung, nicht nur als Laune des Betriebssystems.
 *
 * Die App folgt weiterhin standardmäßig dem System; wer es anders will, legt es
 * fest, und dann gilt das überall gleich: Oberfläche **und** Karte. Letzteres
 * ist der eigentliche Grund für dieses Modul — die Kartenebenen fragten bisher
 * jede für sich das Betriebssystem, und ein Kartenblatt fürs Papier braucht die
 * helle Fassung, egal wie der Bildschirm gerade steht.
 */

import { useEffect, useState } from 'react';

export type ThemeSetting = 'system' | 'light' | 'dark';

const QUERY = '(prefers-color-scheme: dark)';

/** Was das System gerade möchte. */
export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(QUERY).matches;
}

/** Die Einstellung auf die Frage „dunkel?" herunterrechnen. */
export function isDark(setting: ThemeSetting): boolean {
  return setting === 'system' ? systemPrefersDark() : setting === 'dark';
}

/**
 * Das gewählte Thema am Wurzelelement vermerken. Das Stylesheet hängt daran:
 * ohne Attribut gilt die Vorliebe des Systems, mit Attribut die Wahl.
 */
export function applyTheme(setting: ThemeSetting): void {
  const root = document.documentElement;
  if (setting === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', setting);
  // Damit auch Bildlaufleisten und Formularfelder mitziehen.
  root.style.colorScheme = setting === 'system' ? '' : setting;
}

/**
 * Gilt gerade dunkel? Folgt bei „System" auch einem Wechsel im laufenden
 * Betrieb — am Abend schaltet manches Betriebssystem von selbst um.
 */
export function useDark(setting: ThemeSetting): boolean {
  const [dark, setDark] = useState(() => isDark(setting));
  useEffect(() => {
    setDark(isDark(setting));
    if (setting !== 'system') return;
    const media = window.matchMedia(QUERY);
    const onChange = () => setDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [setting]);
  return dark;
}
