/**
 * Ein QR-Code zum Zeigen — und einer zum Ablesen.
 *
 * Zwei Geräte, kein Netz, kein Server: Das eine hält den Bildschirm hin, das
 * andere fotografiert ihn ab. Das ist der einzige Übergabeweg, der weder
 * Kopplung noch Konto noch Empfang braucht — und deshalb der, der im Feld
 * übrig bleibt.
 */

import { useEffect, useRef, useState } from 'react';
import { encodeQr, qrToSvgPath } from './qr.js';

/** Zeigt Text als QR-Code. Zu lange Nutzlast wird ehrlich abgelehnt. */
export function QrCode({ text, size = 220 }: { text: string; size?: number }) {
  const qr = encodeQr(text, text.length > 300 ? 'L' : 'M');
  if (!qr) {
    return (
      <p className="rp-hint err">
        Zu viel für einen QR-Code ({new TextEncoder().encode(text).length} Bytes). Weniger mitgeben —
        etwa ohne Markierungen.
      </p>
    );
  }
  // Vier Module Rand sind vorgeschrieben; ohne sie findet kein Leser den Code.
  const quiet = 4;
  const span = qr.size + quiet * 2;
  return (
    <div className="qr-wrap">
      <svg
        className="qr"
        viewBox={`0 0 ${span} ${span}`}
        width={size}
        height={size}
        role="img"
        aria-label="QR-Code der Ansicht"
        shapeRendering="crispEdges"
      >
        <rect width={span} height={span} fill="#fff" />
        <g transform={`translate(${quiet} ${quiet})`}>
          <path d={qrToSvgPath(qr)} fill="#000" />
        </g>
      </svg>
      <span className="qr-info">
        Version {qr.version}-{qr.ecc} · {new TextEncoder().encode(text).length} Bytes
      </span>
    </div>
  );
}

/** Steht im Browser ein Strichcode-Leser bereit? */
function detectorAvailable(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

interface DetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

/**
 * QR-Code mit der Kamera ablesen.
 *
 * Wo der Browser keinen Leser mitbringt (das ist auf dem Schreibtisch die
 * Regel), bleibt das Einfügen von Hand — der Inhalt ist ja Text.
 */
export function QrScanner({ onText, onClose }: { onText: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  useEffect(() => {
    if (!detectorAvailable()) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer = 0;

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        const Detector = (window as unknown as { BarcodeDetector: new (o: object) => DetectorLike })
          .BarcodeDetector;
        const detector = new Detector({ formats: ['qr_code'] });
        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            const value = found[0]?.rawValue;
            if (value) {
              onText(value);
              return;
            }
          } catch {
            /* einzelne Bilder dürfen scheitern */
          }
          timer = window.setTimeout(tick, 300);
        };
        void tick();
      } catch {
        setError('Auf die Kamera konnte nicht zugegriffen werden.');
      }
    };
    void start();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, [onText]);

  return (
    <div className="qr-scan">
      {detectorAvailable() ? (
        <>
          <video ref={videoRef} className="qr-video" playsInline muted />
          {error && <p className="rp-hint err">{error}</p>}
        </>
      ) : (
        <p className="muted">
          Dieser Browser bringt keinen Strichcode-Leser mit. Den Inhalt des Codes hier einfügen — auf dem
          anderen Gerät steht er auch als Link.
        </p>
      )}
      <div className="qr-manual">
        <input
          type="text"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="Link oder Inhalt einfügen"
          aria-label="Inhalt des QR-Codes"
        />
        <button type="button" className="btn-quiet" onClick={() => manual.trim() && onText(manual.trim())}>
          Übernehmen
        </button>
      </div>
      <button type="button" className="btn-quiet" onClick={onClose}>
        Abbrechen
      </button>
    </div>
  );
}
