import { useEffect, useState } from 'react';
import type { GeoResult } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { fetchGeocode } from './api.js';
import type { Place } from './places.js';

interface Props {
  current: string;
  favorites: Place[];
  isFavorite: boolean;
  onClose: () => void;
  onSelect: (place: Place) => void;
  onUseGeolocation: () => void;
  onSaveCurrent: () => void;
  onRemoveFavorite: (place: Place) => void;
}

const PinIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 21s-7-6.3-7-11a7 7 0 0 1 14 0c0 4.7-7 11-7 11Z" />
    <circle cx="12" cy="10" r="2.2" />
  </svg>
);

export function PlacePicker(props: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<GeoResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      fetchGeocode(term)
        .then((r) => setResults(r.data))
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <Sheet title="Ort wählen" onClose={props.onClose}>
      <div className="pp-search">
        <PinIcon />
        <input
          type="search"
          value={q}
          autoFocus
          placeholder="Ort oder PLZ suchen …"
          onChange={(e) => setQ(e.target.value)}
          aria-label="Ort suchen"
        />
      </div>

      {q.trim().length >= 2 && (
        <div className="pp-results">
          {loading && <p className="muted">Suche …</p>}
          {!loading && results.length === 0 && <p className="muted">Keine Treffer.</p>}
          {results.map((r) => (
            <button key={`${r.lat},${r.lon}`} type="button" className="pp-row" onClick={() => props.onSelect(r)}>
              <PinIcon />
              <span className="pp-label">{r.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="pp-actions">
        <button type="button" className="pp-action" onClick={props.onUseGeolocation}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="7" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          </svg>
          Mein Standort
        </button>
        {!props.isFavorite && (
          <button type="button" className="pp-action" onClick={props.onSaveCurrent}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 21l1.1-6.5L2.6 9.8l6.5-.9Z" />
            </svg>
            „{props.current}" speichern
          </button>
        )}
      </div>

      {props.favorites.length > 0 && (
        <>
          <div className="sect-label">Gespeicherte Orte</div>
          <div className="pp-results">
            {props.favorites.map((f) => (
              <div key={`${f.lat},${f.lon}`} className="pp-row pp-fav">
                <button type="button" className="pp-fav-select" onClick={() => props.onSelect(f)}>
                  <PinIcon />
                  <span className="pp-label">{f.name}</span>
                </button>
                <button
                  type="button"
                  className="pp-del"
                  aria-label="Entfernen"
                  onClick={() => props.onRemoveFavorite(f)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </Sheet>
  );
}
