import { useState } from 'react';

/**
 * Schloss vor der App: ein Feld, ein Knopf.
 *
 * Bewusst kein Blatt über der Karte, sondern eine eigene Seite — solange nicht
 * entsperrt ist, gibt es nichts zu sehen, und ein halb geladener Hintergrund
 * würde nur Fehlermeldungen produzieren.
 */
export function LockScreen({
  onUnlock,
  online,
}: {
  onUnlock: (password: string) => Promise<string | null>;
  online: boolean;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const message = await onUnlock(password);
    setBusy(false);
    if (message) {
      setError(message);
      setPassword('');
    }
  };

  return (
    <div className="lock">
      <form className="lock-box" onSubmit={submit}>
        <div className="lock-brand">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2 4 5.5v6c0 5 3.4 9.4 8 10.5 4.6-1.1 8-5.5 8-10.5v-6z" />
            <path d="m8.5 12 2.5 2.5 4.5-5" />
          </svg>
          <div>
            <h1>Lagebild</h1>
            <p>Dieser Server ist mit einem Passwort geschützt.</p>
          </div>
        </div>

        <label className="lock-field">
          <span>Passwort</span>
          <input
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </label>

        {error && <p className="err">{error}</p>}
        {!online && (
          <p className="muted lock-note">
            Gerade keine Verbindung. Zum Entsperren braucht es <b>einmal</b> Netz — danach läuft
            die App auch ohne.
          </p>
        )}

        <button type="submit" className="btn-primary" disabled={busy || !password}>
          {busy ? 'Wird geprüft …' : 'Entsperren'}
        </button>

        <p className="muted lock-note">
          Das Gerät bleibt danach dauerhaft entsperrt — auch unterwegs ohne Netz. Abgesperrt wird
          nur von Hand über die Einstellungen.
        </p>
      </form>
    </div>
  );
}
