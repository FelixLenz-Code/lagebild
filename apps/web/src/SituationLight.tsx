/**
 * Die Lage-Ampel als Kachel: Stufe, ein Satz, die Gründe darunter — und ein
 * Knopf, der den Satz vorliest.
 *
 * Vorlesen ist hier kein Spielzeug: Wer fährt oder Handschuhe anhat, kann nicht
 * lesen. Die Stimme kommt aus dem Browser (`speechSynthesis`), es geht also
 * nichts an einen Dienst — dieselbe Stimme, die schon die Fahranweisungen
 * spricht.
 */

import { useEffect, useState } from 'react';
import { LEVEL_COLOR, LEVEL_LABEL, type SituationNow } from './situationNow.js';

/** Spricht der Browser gerade? Wird für den Knopfzustand gebraucht. */
function useSpeaking(): [boolean, (text: string) => void] {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    // Beim Verlassen der Seite darf keine Stimme hängen bleiben.
    return () => {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    };
  }, []);
  const speak = (text: string) => {
    if (!('speechSynthesis' in window)) return;
    const synth = window.speechSynthesis;
    if (synth.speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'de-DE';
    utter.rate = 1;
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(utter);
  };
  return [speaking, speak];
}

export function SituationLight({
  situation,
  onDetails,
}: {
  situation: SituationNow;
  /** „Alle Warnungen" öffnen. */
  onDetails?: () => void;
}) {
  const [speaking, speak] = useSpeaking();
  const color = LEVEL_COLOR[situation.level];
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

  return (
    <article className="ampel" data-tab="lage" style={{ borderLeftColor: color }}>
      <div className="am-head">
        <span className="am-dot" style={{ background: color }} aria-hidden="true" />
        <b className="am-level" style={{ color }}>
          {LEVEL_LABEL[situation.level]}
        </b>
        <span className="am-title">Lage hier</span>
        {canSpeak && (
          <button
            type="button"
            className={`iconbtn am-speak${speaking ? ' is-on' : ''}`}
            onClick={() => speak(situation.sentence)}
            title={speaking ? 'Ansage abbrechen' : 'Lage vorlesen'}
            aria-label={speaking ? 'Ansage abbrechen' : 'Lage vorlesen'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 9v6h4l5 4V5L8 9H4Z" />
              {speaking ? <path d="M17 9l4 6M21 9l-4 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7" />}
            </svg>
          </button>
        )}
      </div>

      <p className="am-sentence">{situation.sentence}</p>

      {situation.reasons.length > 1 && (
        <ul className="am-reasons">
          {situation.reasons.slice(0, 5).map((r, i) => (
            <li key={i}>
              <i style={{ background: LEVEL_COLOR[r.level] }} aria-hidden="true" />
              {r.text}
            </li>
          ))}
        </ul>
      )}

      {situation.unknown.length > 0 && (
        <p className="am-unknown">Ungeprüft: {situation.unknown.join(' · ')}</p>
      )}

      {onDetails && situation.reasons.length > 0 && (
        <button type="button" className="btn-quiet am-more" onClick={onDetails}>
          Warnungen im Klartext
        </button>
      )}
    </article>
  );
}
