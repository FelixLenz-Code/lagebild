import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './Root.js';
import { resolveMapAssets } from './mapStyle.js';
import './styles.css';

/*
 * Vor dem ersten Bild klären, woher die Kartenschriften kommen: aus dem eigenen
 * Bundle oder — wenn sie beim Bauen nicht geholt wurden — von Protomaps. Ein
 * Kopf-Abruf gegen die eigene Herkunft, den der Service Worker offline aus dem
 * Vorrat beantwortet; ein Fehlschlag kostet nichts, weil er sofort feststeht.
 *
 * Bewusst kein `await` auf oberster Ebene: Das verlangt ein neueres Bauziel,
 * als die App sonst braucht.
 */
const starten = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );

void resolveMapAssets().then(starten, starten);
