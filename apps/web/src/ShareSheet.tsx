import { useEffect, useState } from 'react';
import { Sheet } from './Sheet.js';
import { buildShareUrl, copyText } from './share.js';
import type { LayerRowId } from './layerCatalog.js';
import { LAYER_CATALOG } from './layerCatalog.js';
import type { MapApi } from './LageMap.js';

interface Props {
  api: MapApi | null;
  layers: LayerRowId[];
  onClose: () => void;
}

/**
 * Ansicht teilen — als Link oder als Bild.
 *
 * Der Link trägt Ausschnitt und Ebenen im Hash; wer ihn öffnet, sieht dieselbe
 * Karte. Das Bild ist ein Abzug der Leinwand samt der Marken, die sonst als
 * HTML daneben liegen — brauchbar für eine Lagebesprechung oder einen
 * Chat-Verlauf.
 */
export function ShareSheet(props: Props) {
  const [url, setUrl] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.api) return;
    const view = props.api.view();
    setUrl(buildShareUrl({ ...view, layers: props.layers }));
  }, [props.api, props.layers]);

  const names = props.layers
    .map((id) => LAYER_CATALOG.find((l) => l.id === id)?.label ?? id)
    .filter(Boolean);

  const makeImage = () => {
    setError(null);
    const data = props.api?.snapshot() ?? null;
    if (!data) {
      setError('Die Karte ließ sich nicht abziehen.');
      return;
    }
    setImage(data);
  };

  const share = async () => {
    const canShare = typeof navigator.share === 'function';
    if (!canShare) {
      const ok = await copyText(url);
      setCopied(ok);
      if (!ok) setError('Der Link ließ sich nicht kopieren — bitte von Hand markieren.');
      return;
    }
    try {
      await navigator.share({ title: 'Lagebild', text: 'Kartenausschnitt', url });
    } catch {
      /* abgebrochen — kein Fehler */
    }
  };

  return (
    <Sheet title="Karte teilen" meta={names.length ? `${names.length} Ebenen` : 'ohne Ebenen'} onClose={props.onClose}>
      <p className="muted st-intro">
        Der Link enthält Ausschnitt und eingeschaltete Ebenen. Er steht im Adress-Anhang und geht
        nie an einen Server — wer ihn öffnet, sieht dieselbe Karte.
      </p>

      <div className="sh-url">
        <input
          type="text"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Link zur Ansicht"
        />
      </div>
      {names.length > 0 && <p className="muted sh-layers">Ebenen: {names.join(', ')}</p>}

      <div className="tr-actions" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn-primary"
          onClick={async () => {
            const ok = await copyText(url);
            setCopied(ok);
            if (!ok) setError('Der Link ließ sich nicht kopieren — bitte von Hand markieren.');
          }}
        >
          {copied ? 'Link kopiert' : 'Link kopieren'}
        </button>
        {typeof navigator.share === 'function' && (
          <button type="button" className="btn-quiet" onClick={share}>
            Weitergeben …
          </button>
        )}
      </div>

      <div className="sect-label" style={{ marginTop: 18 }}>
        Als Bild
      </div>
      {image ? (
        <>
          <img className="sh-image" src={image} alt="Abzug der Karte" />
          <div className="tr-actions">
            <a className="btn-quiet" href={image} download="lagebild-karte.png">
              Bild speichern
            </a>
            <button type="button" className="btn-quiet" onClick={() => setImage(null)}>
              Verwerfen
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted st-intro">
            Ein Abzug der Karte, wie sie gerade zu sehen ist — mit Standort-, Start- und Zielmarke.
            Die Kacheln daneben und offene Popups sind nicht darauf.
          </p>
          <button type="button" className="btn-quiet" onClick={makeImage}>
            Bild erzeugen
          </button>
        </>
      )}

      {error && <p className="err">{error}</p>}
    </Sheet>
  );
}
