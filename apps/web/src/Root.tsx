import { useEffect, useState } from 'react';
import { App } from './App.js';
import { LockScreen } from './LockScreen.js';
import { useAuth } from './auth.js';

/**
 * Schloss oder App.
 *
 * Die Entscheidung liegt bewusst **über** der App: Solange nicht entsperrt ist,
 * wird gar nicht erst geladen — sonst liefen vierzig Abrufe gegen eine
 * verschlossene Tür und jede Kachel zeigte einen Fehler.
 *
 * `App` wird beim Entsperren neu aufgebaut (`key`), damit die Abrufe frisch
 * starten statt auf ihre nächste Aktualisierung zu warten.
 */
export function Root() {
  const auth = useAuth();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [rounds, setRounds] = useState(0);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  if (!auth.unlocked) {
    return (
      <LockScreen
        online={online}
        onUnlock={async (password) => {
          const error = await auth.unlock(password);
          if (!error) setRounds((n) => n + 1);
          return error;
        }}
      />
    );
  }

  return <App key={rounds} onLock={auth.lock} />;
}
