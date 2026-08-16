#!/usr/bin/env bash
#
# build-maps.sh — erzeugt die Offline-Karten (PMTiles) pro Bundesland.
#
# Schneidet aus einer Planet-PMTiles-Datei je einen Bundesland-Ausschnitt
# (Protomaps-Schema, passend zum App-Style) mit `pmtiles extract`. Es wird nur
# der benötigte Ausschnitt per HTTP-Range gestreamt — schnell und datensparsam.
#
# Nutzung:
#   scripts/build-maps.sh                 # Weltkarte + alle 16 Länder
#   scripts/build-maps.sh 04 10 11        # nur bestimmte (Code)
#   scripts/build-maps.sh 00              # nur die grobe Weltkarte
#
# Der Code 00 ist kein Bundesland, sondern die **Weltkarte**: die ganze Erde,
# aber nur bis Zoomstufe WORLD_MAXZOOM (Vorgabe 5). Sie füllt die Karte, wenn
# man ohne Netz herauszoomt — ein Länderausschnitt endet an seiner Grenze.
#
# Konfiguration (Env):
#   SOURCE      Planet-PMTiles (Default: der jüngste öffentliche Tagesbau von
#               Protomaps; für Produktion ggf. eigene/gehostete Datei angeben)
#   OUT_DIR     Zielordner (Default: apps/api/maps)
#   MAXZOOM     max. Zoomstufe (Default: 14 — kleinere Dateien bei weniger)
#   PMTILES_BIN Pfad zum pmtiles-CLI (wird sonst automatisch geladen)
#
set -euo pipefail

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Protomaps baut den Planeten täglich und hält die Bauten einige Wochen vor.
# Ein fester Dateiname wäre nach dem nächsten Aufräumen tot — deshalb wird vom
# heutigen Tag rückwärts gesucht.
PLANET_BASE="${PLANET_BASE:-https://build.protomaps.com}"
SOURCE="${SOURCE:-}"
OUT_DIR="${OUT_DIR:-apps/api/maps}"
MAXZOOM="${MAXZOOM:-14}"
WORLD_MAXZOOM="${WORLD_MAXZOOM:-5}"
PMTILES_BIN="${PMTILES_BIN:-}"
# Zwischenlager für das CLI, damit nicht jeder Lauf es neu lädt.
PMTILES_CACHE="${PMTILES_CACHE:-$HIER/../.cache/bin}"

# code|Name|west,süd,ost,nord  — Bboxes müssen zu apps/web/src/stateBounds.ts passen.
STATES=(
  "01|Schleswig-Holstein|7.8,53.3,11.4,55.1"
  "02|Hamburg|9.7,53.4,10.35,53.75"
  "03|Niedersachsen|6.6,51.3,11.6,53.9"
  "04|Bremen|8.4,53.0,9.0,53.65"
  "05|Nordrhein-Westfalen|5.8,50.3,9.5,52.6"
  "06|Hessen|7.7,49.4,10.25,51.7"
  "07|Rheinland-Pfalz|6.1,48.9,8.55,50.95"
  "08|Baden-Württemberg|7.5,47.5,10.5,49.8"
  "09|Bayern|8.9,47.2,13.9,50.6"
  "10|Saarland|6.3,49.1,7.45,49.65"
  "11|Berlin|13.05,52.3,13.8,52.7"
  "12|Brandenburg|11.2,51.3,14.8,53.6"
  "13|Mecklenburg-Vorpommern|10.5,53.1,14.45,54.7"
  "14|Sachsen|11.8,50.1,15.1,51.7"
  "15|Sachsen-Anhalt|10.5,50.9,13.3,53.05"
  "16|Thüringen|9.8,50.2,12.7,51.65"
)

# --- pmtiles-CLI sicherstellen (sonst passendes Release laden) ---
ensure_pmtiles() {
  if [ -n "$PMTILES_BIN" ] && command -v "$PMTILES_BIN" >/dev/null 2>&1; then return; fi
  if command -v pmtiles >/dev/null 2>&1; then PMTILES_BIN="pmtiles"; return; fi
  if [ -x "$PMTILES_CACHE/pmtiles" ]; then PMTILES_BIN="$PMTILES_CACHE/pmtiles"; return; fi

  local os arch ver asset tmp
  case "$(uname -s)" in Linux) os="Linux" ;; Darwin) os="Darwin" ;; *) echo "Unbekanntes OS — bitte pmtiles-CLI manuell installieren."; exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch="x86_64" ;; aarch64|arm64) arch="arm64" ;; *) echo "Unbekannte Architektur."; exit 1 ;; esac
  echo "→ Lade pmtiles-CLI ($os/$arch) …"
  ver="$(curl -fsSL https://api.github.com/repos/protomaps/go-pmtiles/releases/latest | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"v\{0,1\}\([^"]*\)"/\1/')"
  [ -n "$ver" ] || { echo "Konnte die neueste pmtiles-Fassung nicht ermitteln (kein Netz?)."; exit 1; }
  asset="https://github.com/protomaps/go-pmtiles/releases/download/v${ver}/go-pmtiles_${ver}_${os}_${arch}.tar.gz"
  tmp="$(mktemp -d)"
  curl -fsSL "$asset" -o "$tmp/p.tar.gz" || { echo "Download fehlgeschlagen: $asset"; exit 1; }
  tar xzf "$tmp/p.tar.gz" -C "$tmp" pmtiles
  if mkdir -p "$PMTILES_CACHE" 2>/dev/null && mv "$tmp/pmtiles" "$PMTILES_CACHE/pmtiles" 2>/dev/null; then
    PMTILES_BIN="$PMTILES_CACHE/pmtiles"
  else
    PMTILES_BIN="$tmp/pmtiles"
  fi
  rm -rf "$tmp"
  echo "  pmtiles $("$PMTILES_BIN" version 2>/dev/null | head -1)"
}

# --- Planetdatei finden ---
ensure_source() {
  [ -z "$SOURCE" ] || return 0
  local tag i
  echo "→ Suche den jüngsten Planet-Bau auf $PLANET_BASE …"
  for i in $(seq 0 20); do
    tag="$(date -u -d "-$i day" +%Y%m%d 2>/dev/null || date -u -v-"${i}"d +%Y%m%d)"
    if curl -fsI --max-time 20 "$PLANET_BASE/$tag.pmtiles" >/dev/null 2>&1; then
      SOURCE="$PLANET_BASE/$tag.pmtiles"
      return 0
    fi
  done
  echo "Kein Planet-Bau der letzten 20 Tage erreichbar."
  echo "Eigene Datei angeben:  SOURCE=… scripts/build-maps.sh …"
  exit 1
}

ensure_pmtiles
ensure_source
mkdir -p "$OUT_DIR"

# Auswahl: Argumente = Codes, sonst alle
want=("$@")
selected() { [ ${#want[@]} -eq 0 ] && return 0; local c="$1"; for w in "${want[@]}"; do [ "$w" = "$c" ] && return 0; done; return 1; }

echo "Quelle:  $SOURCE"
echo "Ziel:    $OUT_DIR   (maxzoom $MAXZOOM)"
echo

fehlend=()

# Ein Ausschnitt. Schlägt er fehl, ist das keine Sache für „set -e": die
# anderen Länder sollen trotzdem entstehen. Die Ausgabe des CLI wird
# aufgehoben und nur im Fehlerfall gezeigt — sie ist sonst sehr geschwätzig.
extract() {
  local code="$1"; shift
  local ziel="$OUT_DIR/$code.pmtiles" log
  log="$(mktemp)"
  if "$PMTILES_BIN" extract "$SOURCE" "$ziel" "$@" >"$log" 2>&1 && [ -s "$ziel" ]; then
    printf '   fertig: %s (%s)\n' "$ziel" "$(du -h "$ziel" | cut -f1)"
    rm -f "$log"
    return 0
  fi
  echo "   fehlgeschlagen:"
  sed 's/^/     /' "$log" | tail -10
  rm -f "$log" "$ziel"
  fehlend+=("$code")
  return 1
}

# --- Weltkarte (Code 00) ---
if selected "00"; then
  echo "→ 00  Weltkarte (bis Zoom $WORLD_MAXZOOM)"
  extract 00 --maxzoom="$WORLD_MAXZOOM" || true
fi

for entry in "${STATES[@]}"; do
  IFS='|' read -r code name bbox <<< "$entry"
  selected "$code" || continue
  echo "→ $code  $name"
  extract "$code" --bbox="$bbox" --maxzoom="$MAXZOOM" || true
done

echo
if [ ${#fehlend[@]} -gt 0 ]; then
  echo "Nicht erzeugt: ${fehlend[*]}"
  exit 1
fi
echo "Alle gewünschten Regionen erzeugt in $OUT_DIR/"
echo "Der API-Server liefert sie automatisch unter /api/maps aus."
