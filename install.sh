#!/usr/bin/env bash
#
# install.sh — Lagebild einrichten, aktualisieren und mit Daten füllen.
#
#   curl -fsSL https://raw.githubusercontent.com/FelixLenz-Code/lagebild/main/install.sh | bash
#
# Dasselbe Skript macht beides: Beim ersten Lauf richtet es ein, bei jedem
# weiteren holt es den neuen Stand, baut ihn und startet den Dienst durch. Was
# schon da ist, bleibt — Schlüssel, Passwort und die gebauten Offline-Pakete
# werden nie überschrieben, nur auf Nachfrage geändert.
#
# Es führt durch die ganze Einrichtung, einschließlich der Offline-Pakete:
# ohne sie läuft die App nur online, mit ihnen rechnen Karte, Routing, Suche,
# Höhenprofil und Einwohnerschätzung auf dem Gerät.
#
# Was es anlegt:
#   /opt/lagebild                  Quellcode und gebautes Bundle
#   /opt/lagebild/apps/api/.env    Konfiguration (Schlüssel, Passwort)
#   /opt/lagebild/apps/api/maps    Offline-Pakete je Bundesland
#   Systemnutzer `lagebild`        ohne Login, ohne Passwort
#   lagebild.service               systemd-Dienst, Start beim Hochfahren
#
# Aufruf:
#   bash install.sh            einrichten bzw. aktualisieren, dann Pakete
#   bash install.sh pakete     nur die Offline-Pakete (App bleibt, wie sie ist)
#   bash install.sh hilfe      diese Übersicht
#
# Umgebungsvariablen für unbeaufsichtigte Läufe:
#   LAGEBILD_DIR         Zielverzeichnis (Vorgabe /opt/lagebild)
#   LAGEBILD_BRANCH      Zweig (Vorgabe main)
#   LAGEBILD_FORCE=1     verwirft eigene Änderungen im Zielverzeichnis
#   LAGEBILD_LAENDER     "alle" | "04 11" | "keine" (Vorgabe: nichts bauen)
#   LAGEBILD_PAKETE      "alle" | "karte,routing,hoehen,bevoelkerung" | "keine"
#                        (ohne Terminal und ohne Angabe: karte,routing,hoehen)
#   LAGEBILD_NEUBAU=1    vorhandene Pakete noch einmal bauen
#   LAGEBILD_PBF_BEHALTEN=0   OSM-Auszüge nach dem Bauen löschen (spart GB)
#   LAGEBILD_MAXZOOM     Zoomstufe der Offline-Karte (Vorgabe 14)
#   LAGEBILD_HOEHEN_ZOOM Zoomstufe der Höhenpakete (Vorgabe 10)
#
# Ohne Terminal (etwa in einer Pipeline) fragt das Skript nichts, behält alle
# vorhandenen Werte und baut nur die Pakete, die oben ausdrücklich benannt sind.

set -Eeuo pipefail

REPO="${LAGEBILD_REPO:-https://github.com/FelixLenz-Code/lagebild.git}"
ZWEIG="${LAGEBILD_BRANCH:-main}"
ZIEL="${LAGEBILD_DIR:-/opt/lagebild}"
NUTZER="lagebild"
DIENST="lagebild"
ENV_DATEI="$ZIEL/apps/api/.env"
MIN_NODE=20
# Node, das der Installer selbst mitbringen darf, wenn keins da ist.
NODE_HOLEN_FASSUNG=22

# Bundesländer: Code|Name|Karte MB|Routing+Suche MB|Höhen MB.
# Die Größen sind gemessen (Routing) bzw. grob geschätzt (Karte, Höhen) und
# dienen nur der Vorschau und der Platzprüfung.
LAENDER=(
  "00|Weltkarte (grob)|15|0|0"
  "01|Schleswig-Holstein|290|22|5"
  "02|Hamburg|10|8|1"
  "03|Niedersachsen|585|73|9"
  "04|Bremen|22|3|1"
  "05|Nordrhein-Westfalen|383|118|6"
  "06|Hessen|264|50|4"
  "07|Rheinland-Pfalz|226|40|4"
  "08|Baden-Württemberg|310|99|5"
  "09|Bayern|765|125|12"
  "10|Saarland|28|7|1"
  "11|Berlin|14|17|1"
  "12|Brandenburg|373|44|6"
  "13|Mecklenburg-Vorpommern|284|15|4"
  "14|Sachsen|238|37|4"
  "15|Sachsen-Anhalt|271|20|4"
  "16|Thüringen|189|21|3"
)

# Länder, deren Routing-Bau viel Arbeitsspeicher braucht (großer OSM-Auszug).
GROSSE_LAENDER="03 05 08 09"

ZENSUS_URL="https://www.destatis.de/static/DE/zensus/gitterdaten/Zensus2022_Bevoelkerungszahl.zip"
ZENSUS_CSV_NAME="Zensus2022_Bevoelkerungszahl_100m-Gitter.csv"

# ------------------------------------------------------------------ Ausgabe

if [ -t 1 ]; then
  ROT=$'\033[31m'; GRUEN=$'\033[32m'; GELB=$'\033[33m'; FETT=$'\033[1m'; GRAU=$'\033[90m'; AUS=$'\033[0m'
else
  ROT=''; GRUEN=''; GELB=''; FETT=''; GRAU=''; AUS=''
fi

schritt() { printf '\n%s==>%s %s%s\n' "$GRUEN" "$AUS" "$FETT" "$1$AUS"; }
info()    { printf '    %s\n' "$1"; }
leise()   { printf '    %s%s%s\n' "$GRAU" "$1" "$AUS"; }
warnung() { printf '%s !  %s%s\n' "$GELB" "$1" "$AUS" >&2; }
fehler()  { printf '\n%sFehler: %s%s\n' "$ROT" "$1" "$AUS" >&2; exit 1; }

# Bricht etwas ab, soll klar sein wo — sonst sucht man in 700 Zeilen.
trap 'st=$?; [ $st -ne 0 ] && printf "\n%sAbgebrochen in Zeile %s (Status %s).%s\n" "$ROT" "$LINENO" "$st" "$AUS" >&2; exit $st' ERR

# Ein einziger Arbeitsordner für alles Flüchtige, ein einziges Aufräumen.
ARBEIT="$(mktemp -d)"
chmod 700 "$ARBEIT"
trap 'rm -rf "$ARBEIT"' EXIT

# ------------------------------------------------------------------ Terminal
#
# Beim Aufruf über `curl … | bash` liegt auf der Standardeingabe das Skript
# selbst. Fragen müssen deshalb aus /dev/tty lesen, sonst verschlucken sie
# den eigenen Quelltext.

# Die Datei /dev/tty gibt es immer, sie lässt sich aber nur öffnen, wenn
# wirklich ein Terminal dranhängt. Also öffnen statt Rechte prüfen.
if { : < /dev/tty; } 2>/dev/null; then INTERAKTIV=1; else INTERAKTIV=0; fi

frage() {
  # frage <Text> [-s]  → Antwort auf stdout
  local text="$1" still="${2:-}" antwort=''
  [ "$INTERAKTIV" -eq 1 ] || { printf ''; return 0; }
  printf '%s' "$text" > /dev/tty
  if [ "$still" = "-s" ]; then
    IFS= read -rs antwort < /dev/tty || antwort=''
    printf '\n' > /dev/tty
  else
    IFS= read -r antwort < /dev/tty || antwort=''
  fi
  printf '%s' "$antwort"
}

ja_nein() {
  # ja_nein <Text> <Vorgabe j|n>
  local text="$1" vorgabe="$2" a
  [ "$INTERAKTIV" -eq 1 ] || { [ "$vorgabe" = "j" ]; return; }
  a=$(frage "$text [$( [ "$vorgabe" = j ] && echo 'J/n' || echo 'j/N' )] ")
  a="${a:-$vorgabe}"
  case "$a" in [jJyY]*) return 0 ;; *) return 1 ;; esac
}

# ------------------------------------------------------------------ Rechte

SUDO=''
if [ "$(id -u)" -eq 0 ]; then
  # Schon root: nichts vorzuschalten. Für den Wechsel auf den Dienstnutzer
  # taugt runuser, sonst sudo.
  if command -v runuser >/dev/null 2>&1; then
    WECHSEL=(runuser -u "$NUTZER" --)
  elif command -v sudo >/dev/null 2>&1; then
    WECHSEL=(sudo -u "$NUTZER" --)
  else
    fehler "Weder runuser noch sudo gefunden — einer von beiden wird gebraucht."
  fi
else
  command -v sudo >/dev/null 2>&1 || fehler "Ohne root-Rechte und ohne sudo geht es nicht. Als root ausführen."
  SUDO='sudo'
  WECHSEL=(sudo -u "$NUTZER" --)
fi

als_nutzer() {
  # Der Wechsel behält das Arbeitsverzeichnis des Aufrufers — und das ist beim
  # Lauf als root gern /root, wo der Dienstnutzer nicht hineindarf. Node bricht
  # dann schon beim Ermitteln des Arbeitsverzeichnisses ab. Deshalb wird hier
  # ausdrücklich nach $ZIEL gewechselt.
  #
  # COREPACK_ENABLE_DOWNLOAD_PROMPT: corepack will das Nachladen von pnpm sonst
  # bestätigt haben — und wartet als Dienstnutzer ohne Terminal endlos darauf.
  "${WECHSEL[@]}" env HOME="$ZIEL" PATH="$PATH" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1 \
    sh -c 'cd "$1" || exit 1; shift; exec "$@"' sh "$ZIEL" "$@"
}

# ------------------------------------------------------------------ Helfer

pad() {
  # Links ausgerichtet auf Breite auffüllen. printf zählt Bytes,
  # „Baden-Württemberg" hat aber mehr Bytes als Zeichen — die Tabelle
  # verrutschte sonst genau dort.
  local s="$1" n="$2" l=${#1}
  printf '%s' "$s"
  while [ "$l" -lt "$n" ]; do printf ' '; l=$((l + 1)); done
}

rechts() {
  # Dasselbe rechtsbündig, für die Größenspalten.
  local s="$1" n="$2" l=${#1}
  while [ "$l" -lt "$n" ]; do printf ' '; l=$((l + 1)); done
  printf '%s' "$s"
}

mb_lesbar() {
  # mb_lesbar <MB> → "820 MB" oder "4,2 GB"
  local mb="$1"
  if [ "$mb" -lt 1024 ]; then printf '%s MB' "$mb"
  else printf '%s,%s GB' "$((mb / 1024))" "$(((mb % 1024) * 10 / 1024))"
  fi
}

frei_mb() {
  # Freier Platz auf dem Dateisystem eines Pfads — auch wenn der noch fehlt.
  local p="$1"
  while [ ! -d "$p" ] && [ "$p" != "/" ]; do p="$(dirname "$p")"; done
  df -Pm "$p" 2>/dev/null | awk 'NR==2 {print $4}'
}

speicher_mb() {
  # Arbeitsspeicher samt Auslagerung — der Routing-Bau braucht beides.
  awk '/^MemTotal:/ {m=$2} /^SwapTotal:/ {s=$2} END {print int((m+s)/1024)}' /proc/meminfo 2>/dev/null || echo 0
}

paketmanager() {
  for pm in apt-get dnf yum zypper pacman apk; do
    command -v "$pm" >/dev/null 2>&1 && { printf '%s' "$pm"; return 0; }
  done
  return 1
}

werkzeug_nachlegen() {
  # werkzeug_nachlegen <Paketname…> — installiert, wenn der Nutzer zustimmt.
  local pm
  pm="$(paketmanager)" || return 1
  ja_nein "    Jetzt mit $pm installieren: $*?" j || return 1
  case "$pm" in
    apt-get) $SUDO apt-get update -qq && $SUDO apt-get install -y "$@" ;;
    dnf|yum) $SUDO "$pm" install -y "$@" ;;
    zypper)  $SUDO zypper --non-interactive install "$@" ;;
    pacman)  $SUDO pacman -Sy --noconfirm "$@" ;;
    apk)     $SUDO apk add --no-cache "$@" ;;
  esac
}

land_feld() {
  # land_feld <code> <feld 2..5> → Wert aus der Tabelle
  local code="$1" feld="$2" e
  for e in "${LAENDER[@]}"; do
    case "$e" in "$code|"*) printf '%s' "$(printf '%s' "$e" | cut -d'|' -f"$feld")"; return 0 ;; esac
  done
  return 1
}

land_bekannt() { land_feld "$1" 2 >/dev/null 2>&1; }

# ------------------------------------------------------------------ Prüfungen

pruefen() {
  schritt "Voraussetzungen prüfen"

  local fehlend=()
  for werkzeug in git curl tar; do
    command -v "$werkzeug" >/dev/null 2>&1 || fehlend+=("$werkzeug")
  done
  if [ ${#fehlend[@]} -gt 0 ]; then
    warnung "Es fehlen: ${fehlend[*]}"
    werkzeug_nachlegen "${fehlend[@]}" || fehler "Ohne ${fehlend[*]} geht es nicht. Nachinstallieren und noch einmal aufrufen."
    for werkzeug in "${fehlend[@]}"; do
      command -v "$werkzeug" >/dev/null 2>&1 || fehler "„$werkzeug\" ist noch immer nicht da."
    done
  fi
  info "git, curl, tar vorhanden"

  command -v systemctl >/dev/null 2>&1 || fehler "Dieses Skript richtet einen systemd-Dienst ein; systemctl wurde nicht gefunden."

  node_pruefen
  pnpm_pruefen

  local frei speicher
  frei="$(frei_mb "$ZIEL")"
  # Quellcode, node_modules und das gebaute Bundle liegen bei rund 1 GB.
  if [ -n "$frei" ] && [ "$frei" -lt 2048 ]; then
    warnung "Nur noch $(mb_lesbar "$frei") frei unter $ZIEL — für Quellcode und Bau sollten es 2 GB sein."
    ja_nein "Trotzdem weitermachen?" n || exit 1
  fi
  speicher="$(speicher_mb)"
  if [ "$speicher" -gt 0 ] && [ "$speicher" -lt 1500 ]; then
    warnung "Nur $(mb_lesbar "$speicher") Arbeitsspeicher samt Auslagerung — der Bau der Oberfläche kann daran scheitern."
    warnung "Abhilfe: eine Auslagerungsdatei anlegen (z.B. 2 GB mit fallocate + swapon)."
  fi
  info "Platz: $(mb_lesbar "${frei:-0}") frei, Speicher: $(mb_lesbar "$speicher")"
}

node_pruefen() {
  if ! command -v node >/dev/null 2>&1; then
    warnung "Node.js fehlt. Nötig ist Fassung $MIN_NODE oder neuer."
    node_nachlegen || fehler "Node.js $MIN_NODE oder neuer installieren — siehe https://nodejs.org/de/download/package-manager"
  fi

  NODE_BIN="$(command -v node)"
  local fassung
  fassung="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$fassung" -lt "$MIN_NODE" ]; then
    warnung "Node.js $fassung ist zu alt, nötig ist $MIN_NODE oder neuer."
    node_nachlegen || fehler "Node.js $MIN_NODE oder neuer installieren — siehe https://nodejs.org/de/download/package-manager"
    NODE_BIN="$(command -v node)"
    fassung="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    [ "$fassung" -ge "$MIN_NODE" ] || fehler "Node.js ist noch immer zu alt ($fassung)."
  fi
  info "Node.js $(node -v) unter $NODE_BIN"

  # Ein Node aus nvm liegt im Heimverzeichnis eines Menschen. Der Dienstnutzer
  # kommt da unter Umständen nicht heran, und beim nächsten nvm-Wechsel zeigt
  # der Pfad ins Leere.
  case "$NODE_BIN" in
    /home/*|/root/*|*/.nvm/*)
      warnung "Node liegt unter $NODE_BIN — das ist eine Installation im Heimverzeichnis (nvm o.ä.)."
      warnung "Der Dienst läuft als Nutzer „$NUTZER\" und braucht ein systemweites Node (/usr/bin/node)."
      ja_nein "Trotzdem weitermachen?" n || exit 1
      ;;
  esac
}

node_nachlegen() {
  # Nur für apt-Systeme automatisch: dort ist NodeSource der übliche Weg.
  command -v apt-get >/dev/null 2>&1 || return 1
  info "Für Debian/Ubuntu gibt es Node $NODE_HOLEN_FASSUNG bei NodeSource:"
  leise "https://deb.nodesource.com/setup_${NODE_HOLEN_FASSUNG}.x  (Skript von NodeSource, wird als root ausgeführt)"
  ja_nein "    Node $NODE_HOLEN_FASSUNG jetzt von dort installieren?" j || return 1
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_HOLEN_FASSUNG}.x" -o "$ARBEIT/nodesource.sh" || return 1
  $SUDO bash "$ARBEIT/nodesource.sh" || return 1
  $SUDO apt-get install -y nodejs || return 1
  hash -r
  command -v node >/dev/null 2>&1
}

pnpm_melden() {
  # `pnpm --version` ist bei einem corepack-Shim ein Netzzugriff und darf
  # deshalb scheitern, ohne den Installer mitzunehmen.
  local v
  v="$(pnpm --version 2>/dev/null || true)"
  info "pnpm ${v:-(bereitgestellt)}"
}

pnpm_pruefen() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm_melden
    return 0
  fi
  if command -v corepack >/dev/null 2>&1; then
    info "pnpm fehlt — wird über corepack bereitgestellt"
    if $SUDO corepack enable pnpm >/dev/null 2>&1; then
      hash -r
      if command -v pnpm >/dev/null 2>&1; then pnpm_melden; return 0; fi
    fi
    warnung "corepack konnte pnpm nicht bereitstellen."
  else
    warnung "Weder pnpm noch corepack gefunden."
  fi
  ja_nein "    pnpm jetzt global über npm installieren?" j || fehler "Ohne pnpm geht es nicht: npm install -g pnpm"
  command -v npm >/dev/null 2>&1 || fehler "npm fehlt ebenfalls — bitte Node.js samt npm installieren."
  $SUDO npm install -g pnpm >/dev/null || fehler "npm install -g pnpm ist fehlgeschlagen."
  hash -r
  command -v pnpm >/dev/null 2>&1 || fehler "pnpm ist nach der Installation nicht im Pfad."
  pnpm_melden
}

# ------------------------------------------------------------------ Nutzer

nutzer_anlegen() {
  schritt "Systemnutzer „$NUTZER\""

  if id "$NUTZER" >/dev/null 2>&1; then
    info "vorhanden"
  else
    $SUDO useradd --system --home-dir "$ZIEL" --shell /usr/sbin/nologin "$NUTZER"
    info "angelegt (kein Login, kein Passwort)"
  fi
}

# ------------------------------------------------------------------ Quellcode

VORHER=''        # Stand vor der Aktualisierung, für den Rückweg
VORHER_TEXT=''   # derselbe Stand lesbar, für die Anzeige
JETZT_TEXT=''    # Stand nach der Aktualisierung

# Ein Stand in einer Zeile: Kennung, Datum, Betreff. Das Datum ist die Zahl,
# an der man sich festhält — eine Kennung wie „f79cec3" sagt niemandem, ob sie
# von gestern oder vom letzten Jahr ist.
stand_text() {
  # stand_text <commit-ish>
  local wo="${1:-HEAD}" kennung datum betreff marke
  kennung="$(als_nutzer git -C "$ZIEL" rev-parse --short=7 "$wo" 2>/dev/null || true)"
  [ -n "$kennung" ] || { printf 'unbekannt'; return 0; }
  # Eine Marke, falls es eine gibt — sonst bleibt es bei der Kennung.
  marke="$(als_nutzer git -C "$ZIEL" describe --tags --exact-match "$wo" 2>/dev/null || true)"
  datum="$(als_nutzer git -C "$ZIEL" log -1 --format=%cs "$wo" 2>/dev/null || true)"
  betreff="$(als_nutzer git -C "$ZIEL" log -1 --format=%s "$wo" 2>/dev/null || true)"
  # Lange Betreffs umbrechen die Zeile und machen die Gegenüberstellung
  # unlesbar — hier wird gekürzt, nicht umgebrochen.
  [ "${#betreff}" -gt 52 ] && betreff="${betreff:0:51}…"
  printf '%-9s %-10s %s' "${marke:-$kennung}" "${datum:-—}" "$betreff"
}

# Version aus der package.json (die Zahl, die im Projekt selbst steht).
paket_version() {
  als_nutzer sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$ZIEL/package.json" 2>/dev/null | head -1
}

quellcode() {
  schritt "Quellcode holen"

  $SUDO mkdir -p "$ZIEL"
  $SUDO chown "$NUTZER":"$NUTZER" "$ZIEL"

  if [ -d "$ZIEL/.git" ]; then
    # Eigene Änderungen im Zielverzeichnis würden beim Aktualisieren verloren
    # gehen — deshalb erst fragen, nicht einfach überschreiben.
    if ! als_nutzer git -C "$ZIEL" diff --quiet HEAD 2>/dev/null; then
      warnung "In $ZIEL liegen eigene Änderungen am Quellcode."
      if [ "${LAGEBILD_FORCE:-0}" = "1" ] || ja_nein "Verwerfen und den neuen Stand holen?" n; then
        als_nutzer git -C "$ZIEL" reset --hard
      else
        fehler "Abgebrochen, damit nichts verloren geht."
      fi
    fi
    VORHER="$(als_nutzer git -C "$ZIEL" rev-parse HEAD 2>/dev/null || true)"
    # Beschreibung **vor** dem Holen sichern: Danach zeigt HEAD woanders hin.
    VORHER_TEXT="$(stand_text HEAD)"
    local version_vorher version_jetzt
    version_vorher="$(paket_version)"

    als_nutzer git -C "$ZIEL" fetch --depth 1 origin "$ZWEIG"
    als_nutzer git -C "$ZIEL" checkout -q -B "$ZWEIG" "origin/$ZWEIG"

    JETZT_TEXT="$(stand_text HEAD)"
    version_jetzt="$(paket_version)"
    local jetzt
    jetzt="$(als_nutzer git -C "$ZIEL" rev-parse HEAD)"

    if [ -n "$VORHER" ] && [ "$VORHER" = "$jetzt" ]; then
      printf '    %sschon auf dem neuesten Stand%s\n' "$FETT" "$AUS"
      printf '            %s%s%s\n' "$GRAU" "$JETZT_TEXT" "$AUS"
    else
      # Die eigentliche Antwort auf „was ändert sich hier gerade": zwei Zeilen
      # untereinander, gleich ausgerichtet, damit der Unterschied ins Auge
      # springt statt gesucht werden zu müssen.
      printf '    %sAktualisierung%s\n' "$FETT" "$AUS"
      printf '      von   %s%s%s\n' "$GRAU" "$VORHER_TEXT" "$AUS"
      printf '      auf   %s%s%s\n' "$FETT" "$JETZT_TEXT" "$AUS"
      if [ -n "$version_vorher" ] && [ "$version_vorher" != "$version_jetzt" ]; then
        printf '      Version %s → %s%s%s\n' "$version_vorher" "$FETT" "$version_jetzt" "$AUS"
      fi
      # Wie viele Änderungen dazwischen liegen, weiß ein flacher Klon nicht —
      # lieber nichts sagen als eine erfundene Zahl.
    fi
  else
    # Ein nicht leeres Verzeichnis ohne .git ist nichts, worin man klonen will.
    if [ -n "$($SUDO ls -A "$ZIEL" 2>/dev/null || true)" ]; then
      fehler "$ZIEL ist nicht leer, enthält aber kein Git-Verzeichnis. Bitte prüfen und leeren."
    fi
    als_nutzer git clone --depth 1 --branch "$ZWEIG" "$REPO" "$ZIEL"
    JETZT_TEXT="$(stand_text HEAD)"
    info "geklont nach $ZIEL"
    printf '      Stand %s%s%s\n' "$FETT" "$JETZT_TEXT" "$AUS"
  fi
}

# ------------------------------------------------------------------ .env
#
# Bestehende Werte lesen, zeigen (maskiert) und auf Wunsch ändern. Enter behält,
# ein einzelner Bindestrich löscht.

ARBEITS_ENV=''

env_lesen() {
  awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$ARBEITS_ENV"
}

env_setzen() {
  # Schlüssel und Wert kommen über die Umgebung, damit awk in keinem von beiden
  # Sonderzeichen deutet.
  local schluessel="$1" wert="$2" tmp
  tmp="$ARBEIT/env.$$"
  LB_K="$schluessel" LB_V="$wert" awk '
    BEGIN { k = ENVIRON["LB_K"]; v = ENVIRON["LB_V"] }
    # Steht der Schlüssel mehrfach da (von Hand editiert), gilt der erste —
    # so liest die App die Datei auch. Die späteren fliegen raus, sonst sieht
    # man beim nächsten Mal einen Wert, der gar nicht wirkt.
    index($0, k "=") == 1 { if (!gefunden) { print k "=" v; gefunden = 1 } next }
    { print }
    END { if (!gefunden) print k "=" v }
  ' "$ARBEITS_ENV" > "$tmp"
  mv "$tmp" "$ARBEITS_ENV"
  chmod 600 "$ARBEITS_ENV"
}

env_sichern() {
  $SUDO cp "$ARBEITS_ENV" "$ENV_DATEI"
  $SUDO chown "$NUTZER":"$NUTZER" "$ENV_DATEI"
  $SUDO chmod 600 "$ENV_DATEI"
}

maskiere() {
  local w="$1"
  if [ -z "$w" ]; then printf '(nicht gesetzt)'
  elif [ "${#w}" -le 8 ]; then printf '***'
  else printf '%s***%s' "${w:0:3}" "${w: -3}"
  fi
}

abfragen() {
  # abfragen <SCHLUESSEL> <Beschriftung> <Hinweis> [-s]
  local schluessel="$1" name="$2" hinweis="$3" still="${4:-}" alt neu
  alt="$(env_lesen "$schluessel")"
  printf '\n  %s%s%s\n' "$FETT" "$name" "$AUS"
  [ -n "$hinweis" ] && printf '    %s\n' "$hinweis"
  printf '    aktuell: %s\n' "$(maskiere "$alt")"
  if [ "$INTERAKTIV" -eq 0 ]; then
    printf '    (kein Terminal — bleibt unverändert)\n'
    return 0
  fi
  neu="$(frage "    neu [Enter behält, „-\" löscht]: " "$still")"
  case "$neu" in
    '')  printf '    unverändert\n' ;;
    '-') env_setzen "$schluessel" ''; printf '    gelöscht\n' ;;
    *)   env_setzen "$schluessel" "$neu"; printf '    gesetzt\n' ;;
  esac
}

passwort_abfragen() {
  # Wie abfragen, aber verdeckt, mit Wiederholung und mit Vorschlag. Ein
  # Vertipper hier sperrt sonst den eigenen Zugang aus.
  local alt neu neu2 vorschlag
  alt="$(env_lesen APP_PASSWORD)"
  printf '\n  %sPasswort vor dem Server%s\n' "$FETT" "$AUS"
  printf '    leer: offen für alle. Nur mit HTTPS davor sinnvoll.\n'
  printf '    aktuell: %s\n' "$(maskiere "$alt")"
  if [ "$INTERAKTIV" -eq 0 ]; then
    printf '    (kein Terminal — bleibt unverändert)\n'
    [ -n "$alt" ] || warnung "Ohne Passwort ist der Server für jeden offen, der ihn erreicht."
    return 0
  fi
  vorschlag="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-16)"
  printf '    Vorschlag: %s   (mit „!" übernehmen)\n' "$vorschlag"
  while :; do
    neu="$(frage "    neu [Enter behält, „-\" löscht, „!\" nimmt den Vorschlag]: " -s)"
    case "$neu" in
      '')  printf '    unverändert\n'; break ;;
      '-') env_setzen APP_PASSWORD ''; printf '    gelöscht — der Server ist offen\n'; break ;;
      '!') env_setzen APP_PASSWORD "$vorschlag"; printf '    gesetzt auf den Vorschlag: %s\n' "$vorschlag"; break ;;
      *)
        neu2="$(frage "    noch einmal: " -s)"
        if [ "$neu" = "$neu2" ]; then env_setzen APP_PASSWORD "$neu"; printf '    gesetzt\n'; break; fi
        printf '    %sstimmt nicht überein — noch einmal%s\n' "$GELB" "$AUS"
        ;;
    esac
  done
}

proxy_abfragen() {
  # Steht ein Reverse-Proxy davor? Dann muss der Server wissen, von welcher
  # Adresse er kommt — sonst sieht er für jeden Nutzer dieselbe.
  local alt neu
  alt="$(env_lesen TRUST_PROXY)"
  printf '\n  %sReverse-Proxy davor%s\n' "$FETT" "$AUS"
  printf '    Adresse des Proxys (IP oder CIDR, mehrere mit Komma).\n'
  printf '    Ohne Angabe sehen alle Nutzer für den Server gleich aus: Ein Fremder\n'
  printf '    sperrt dann mit fünf falschen Passwörtern jeden aus, und das\n'
  printf '    Anmelde-Cookie bekommt kein „Secure".\n'
  printf '    Kein Proxy? Leer lassen.\n'
  case "$alt" in
    '')      printf '    aktuell: (keiner)\n' ;;
    1|all)   printf '    aktuell: %sjeder Verbindung%s — riskant, solange Port %s offen erreichbar ist\n' "$GELB" "$AUS" "$PORT" ;;
    *)       printf '    aktuell: %s\n' "$alt" ;;
  esac
  if [ "$INTERAKTIV" -eq 0 ]; then
    printf '    (kein Terminal — bleibt unverändert)\n'
    return 0
  fi
  neu="$(frage "    neu [Enter behält, „-\" löscht]: ")"
  case "$neu" in
    '')  printf '    unverändert\n' ;;
    '-') env_setzen TRUST_PROXY ''; printf '    gelöscht — keine Kopfzeile wird geglaubt\n' ;;
    *)   env_setzen TRUST_PROXY "$neu"; printf '    gesetzt\n'
         printf '    %sDer Proxy muss beide Kopfzeilen selbst setzen:%s\n' "$FETT" "$AUS"
         printf '      proxy_set_header X-Forwarded-For   $remote_addr;\n'
         printf '      proxy_set_header X-Forwarded-Proto $scheme;\n'
         ;;
  esac
}

konfiguration() {
  schritt "Schlüssel und Passwort"

  if [ ! -f "$ENV_DATEI" ] && [ -f "$ZIEL/apps/api/.env.example" ]; then
    als_nutzer cp "$ZIEL/apps/api/.env.example" "$ENV_DATEI"
    info "aus .env.example angelegt"
  fi
  als_nutzer touch "$ENV_DATEI"
  $SUDO chmod 600 "$ENV_DATEI"

  # Zum Bearbeiten wandert die Datei in eine Kopie unter eigener Hand: awk über
  # sudo hinweg mit Werten zu füttern ist heikel (sudo räumt die Umgebung aus),
  # und Passwörter dürfen keine Kommandozeile sehen.
  ARBEITS_ENV="$ARBEIT/env"
  : > "$ARBEITS_ENV"
  chmod 600 "$ARBEITS_ENV"
  $SUDO cat "$ENV_DATEI" > "$ARBEITS_ENV" 2>/dev/null || true

  info "Alle drei Schlüssel sind freiwillig — ohne sie blendet die App genau die"
  info "eine Ebene aus, die daran hängt. Alles andere läuft."

  abfragen TOMTOM_KEY     "Verkehrsfluss (TomTom)"        "leer lassen: Ebene bleibt ausgeblendet"
  abfragen AISSTREAM_KEY  "Schiffsverkehr (aisstream.io)" "kostenlos nach Anmeldung"
  abfragen APRSFI_KEY     "Amateurfunk (aprs.fi)"         "eigener Schlüssel je Nutzer"
  passwort_abfragen
  proxy_abfragen

  # Pfade fest eintragen: Der Dienst startet in apps/api, das gebaute Bundle
  # liegt aber in apps/web/dist. Ohne diese beiden Zeilen liefert der Server nur
  # die Schnittstelle aus, nicht die Oberfläche.
  env_setzen WEB_ROOT "$ZIEL/apps/web/dist"
  env_setzen MAPS_DIR "$ZIEL/apps/api/maps"
  env_sichern

  PORT="$(env_lesen PORT)"; PORT="${PORT:-8787}"
  HOST="$(env_lesen HOST)"; HOST="${HOST:-0.0.0.0}"
  MAPS_DIR="$ZIEL/apps/api/maps"
}

# ------------------------------------------------------------------ Bauen

bauen() {
  # Läuft in einer Bedingung — deshalb hier keine Verlässlichkeit auf set -e,
  # sondern ausdrückliches Prüfen nach jedem Schritt.
  local sperre='--frozen-lockfile'
  [ "${LAGEBILD_ALLOW_LOCK_UPDATE:-0}" = "1" ] && sperre='--no-frozen-lockfile'

  if ! als_nutzer pnpm --dir "$ZIEL" install "$sperre"; then
    if [ "$sperre" = '--frozen-lockfile' ]; then
      warnung "pnpm install hat abgelehnt — meist passt pnpm-lock.yaml nicht zu den package.json."
      if ja_nein "Sperrdatei anpassen lassen (pnpm install ohne --frozen-lockfile)?" n; then
        als_nutzer pnpm --dir "$ZIEL" install --no-frozen-lockfile || return 1
      else
        return 1
      fi
    else
      return 1
    fi
  fi
  info "Abhängigkeiten installiert"

  als_nutzer pnpm --dir "$ZIEL" -r build || return 1
  info "gebaut"

  [ -f "$ZIEL/apps/api/dist/index.js" ]     || { warnung "Der Bau hat keine apps/api/dist/index.js erzeugt."; return 1; }
  [ -f "$ZIEL/apps/web/dist/index.html" ]   || { warnung "Der Bau hat kein Web-Bundle erzeugt."; return 1; }
  return 0
}

bauen_mit_rueckweg() {
  schritt "Abhängigkeiten und Bau"

  if bauen; then
    bau_nachpruefen
    $SUDO chown -R "$NUTZER":"$NUTZER" "$ZIEL"
    return 0
  fi

  warnung "Der Bau ist fehlgeschlagen."
  if [ -n "$VORHER" ] && ja_nein "Zurück auf: ${VORHER_TEXT:-$(printf '%.7s' "$VORHER")} — und diesen bauen?" j; then
    als_nutzer git -C "$ZIEL" checkout -q --detach "$VORHER" || fehler "Auch der Rückweg ist fehlgeschlagen. $ZIEL von Hand prüfen."
    if bauen; then
      warnung "Zurück auf dem alten Stand — der neue Stand baut hier nicht."
      warnung "Das Protokoll oben zeigt, woran es lag."
      bau_nachpruefen
      $SUDO chown -R "$NUTZER":"$NUTZER" "$ZIEL"
      return 0
    fi
  fi
  fehler "Bau fehlgeschlagen. Der Dienst läuft (falls schon eingerichtet) mit dem alten Stand weiter."
}

bau_nachpruefen() {
  # Zwei Dinge kommen aus dem Netz und dürfen fehlen, ohne den Bau zu stoppen —
  # dann fehlt aber genau eine Fähigkeit, und das soll man hier erfahren.
  if [ ! -d "$ZIEL/apps/web/dist/basemaps/fonts" ]; then
    warnung "Kartenschriften fehlen im Bundle — Namen auf der Offline-Karte bleiben leer."
    warnung "Nachholen: cd $ZIEL && sudo -u $NUTZER pnpm assets:karte && sudo -u $NUTZER pnpm -r build"
  fi
  if [ ! -f "$ZIEL/apps/web/dist/hazmat.json" ]; then
    warnung "hazmat.json fehlt — die Gefahrgut-Ebene bleibt ohne Stoffdaten."
    warnung "Bauen mit: scripts/build-hazmat.mjs (braucht poppler und das ERG-PDF)."
  fi
}

# ------------------------------------------------------------------ Dienst

dienst() {
  schritt "systemd-Dienst"

  # ProtectHome sperrt dem Dienst /home. Liegt das Ziel dort, muss die Sperre
  # gelockert werden — sonst findet der Dienst sein eigenes Verzeichnis nicht.
  local schutz_home
  case "$ZIEL" in
    /home/*|/root/*) schutz_home='read-only' ;;
    *)               schutz_home='true' ;;
  esac

  local unit="/etc/systemd/system/$DIENST.service"
  cat > "$ARBEIT/unit" <<UNITENDE
[Unit]
Description=Lagebild — Wetter, Warnungen, Verkehr
Documentation=https://github.com/FelixLenz-Code/lagebild
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$NUTZER
Group=$NUTZER
WorkingDirectory=$ZIEL/apps/api
ExecStart=$NODE_BIN $ZIEL/apps/api/dist/index.js
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5

# Absicherung: Der Dienst braucht nur lesen und ins eigene Verzeichnis schreiben.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=$schutz_home
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=$ZIEL

[Install]
WantedBy=multi-user.target
UNITENDE

  if $SUDO cmp -s "$ARBEIT/unit" "$unit" 2>/dev/null; then
    info "Beschreibung unverändert"
  else
    $SUDO cp "$ARBEIT/unit" "$unit"
    $SUDO chmod 644 "$unit"
    $SUDO systemctl daemon-reload
    info "$DIENST.service geschrieben"
  fi
  $SUDO systemctl enable "$DIENST" >/dev/null 2>&1
  $SUDO systemctl restart "$DIENST"
  info "gestartet"
}

probe() {
  schritt "Probe"

  local erreichbar=0 i
  # 30 Sekunden: ein kleiner Server braucht auf schwacher Hardware länger als
  # zehn, und ein zu früher Abbruch schickt Leute grundlos ins Protokoll.
  for i in $(seq 1 30); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      erreichbar=1; break
    fi
    $SUDO systemctl is-active --quiet "$DIENST" || break
    sleep 1
  done

  if [ "$erreichbar" -eq 1 ]; then
    info "Der Server antwortet auf http://127.0.0.1:$PORT/api/health"
    return 0
  fi

  warnung "Der Server antwortet nicht auf Port $PORT."
  printf '\n%s' "$GRAU"
  $SUDO journalctl -u "$DIENST" -n 25 --no-pager 2>/dev/null || true
  printf '%s\n' "$AUS"
  if [ -n "$VORHER" ] && ja_nein "Zurück auf: ${VORHER_TEXT:-$(printf '%.7s' "$VORHER")} — und neu starten?" j; then
    als_nutzer git -C "$ZIEL" checkout -q --detach "$VORHER" && bauen && $SUDO systemctl restart "$DIENST" \
      || fehler "Der Rückweg ist fehlgeschlagen. $ZIEL von Hand prüfen."
    warnung "Zurück auf dem alten Stand."
    return 0
  fi
  fehler "Dienst startet nicht. Protokoll: journalctl -u $DIENST -n 100 --no-pager"
}

# ------------------------------------------------------------------ Pakete

datei_ok() {
  # datei_ok <datei> <mindestgröße> — eine abgebrochene Übertragung hinterlässt
  # eine Datei, die es „gibt". Erst die Größe unterscheidet sie von einem Paket.
  local f="$1" min="$2" s
  [ -f "$f" ] || return 1
  s="$(stat -c%s "$f" 2>/dev/null || echo 0)"
  [ "$s" -ge "$min" ]
}

paket_da() {
  # paket_da <code> <karte|routing|hoehen|bevoelkerung>
  local code="$1" typ="$2"
  case "$typ" in
    karte)        datei_ok "$MAPS_DIR/$code.pmtiles" 100000 ;;
    routing)      datei_ok "$MAPS_DIR/$code.route" 50000 && datei_ok "$MAPS_DIR/$code.search" 20000 ;;
    hoehen)       datei_ok "$MAPS_DIR/$code.terrain" 1000 ;;
    bevoelkerung) datei_ok "$MAPS_DIR/$code.pop" 500 ;;
  esac
}

paket_name() {
  case "$1" in
    karte) printf 'Karte' ;; routing) printf 'Routing+Suche' ;;
    hoehen) printf 'Höhen' ;; bevoelkerung) printf 'Einwohner' ;;
  esac
}

ergebnis_pruefen() {
  # ergebnis_pruefen <typ> <code…>
  #
  # Nicht jeder Baulauf, der ohne Fehler endet, hat auch etwas erzeugt —
  # build-maps.sh etwa überspringt stillschweigend, was es nicht kennt. Deshalb
  # zählt hier die Datei, nicht der Rückgabewert.
  local typ="$1"; shift
  local code fehlt=''
  for code in "$@"; do
    paket_da "$code" "$typ" || fehlt="$fehlt $code"
  done
  [ -n "$fehlt" ] || return 0
  warnung "$(paket_name "$typ"): keine Datei entstanden für$fehlt"
  FEHLGESCHLAGEN+=("$(paket_name "$typ") fehlt für$fehlt")
  return 1
}

bestand_zeile() {
  local code="$1" da=''
  paket_da "$code" karte        && da="$da, Karte"
  paket_da "$code" routing      && da="$da, Routing+Suche"
  paket_da "$code" hoehen       && da="$da, Höhen"
  paket_da "$code" bevoelkerung && da="$da, Einwohner"
  if [ -z "$da" ]; then printf '—'; else printf '%s' "${da:2}"; fi
}

uebersicht_zeigen() {
  printf '    %s%s %s %s %s %s   %s%s\n' "$GRAU" \
    "Code" "$(pad 'Land' 26)" "$(rechts 'Karte' 8)" "$(rechts 'Routing' 9)" "$(rechts 'Höhen' 6)" "schon da" "$AUS"
  local e code name k r h
  for e in "${LAENDER[@]}"; do
    IFS='|' read -r code name k r h <<< "$e"
    [ "$code" = "00" ] && { r='-'; h='-'; } || { r="${r} MB"; h="${h} MB"; }
    printf '    %-4s %s %s %s %s   %s\n' "$code" "$(pad "$name" 26)" \
      "$(rechts "${k} MB" 8)" "$(rechts "$r" 9)" "$(rechts "$h" 6)" "$(bestand_zeile "$code")"
  done
}

laender_abfragen() {
  # Setzt GEWAEHLT (Array von Codes). Leer heißt: nichts bauen.
  GEWAEHLT=()
  local eingabe='' versuche=0 tok
  local vorgabe="${LAGEBILD_LAENDER:-}"

  if [ -n "$vorgabe" ]; then
    eingabe="$vorgabe"
  elif [ "$INTERAKTIV" -eq 0 ]; then
    return 0
  fi

  while :; do
    if [ -z "$eingabe" ]; then
      eingabe="$(frage "    Codes durch Leerzeichen, „alle\", Enter = keine: ")"
    fi
    case "${eingabe,,}" in
      ''|keine|nein) return 0 ;;
      alle)
        for tok in "${LAENDER[@]}"; do GEWAEHLT+=("${tok%%|*}"); done
        return 0
        ;;
    esac
    local ok=1
    GEWAEHLT=()
    for tok in $eingabe; do
      if land_bekannt "$tok"; then GEWAEHLT+=("$tok"); else warnung "„$tok\" ist kein bekannter Code."; ok=0; fi
    done
    [ "$ok" -eq 1 ] && [ ${#GEWAEHLT[@]} -gt 0 ] && return 0
    GEWAEHLT=()
    versuche=$((versuche + 1))
    [ "$versuche" -ge 3 ] && { warnung "Keine gültige Auswahl — Pakete werden übersprungen."; return 0; }
    [ "$INTERAKTIV" -eq 1 ] || return 0
    eingabe=''
  done
}

typen_abfragen() {
  # Setzt TYPEN (Array).
  TYPEN=()
  local vorgabe="${LAGEBILD_PAKETE:-}"
  if [ -n "$vorgabe" ]; then
    case "${vorgabe,,}" in
      keine|nein) return 0 ;;
      alle) TYPEN=(karte routing hoehen bevoelkerung); return 0 ;;
    esac
    local t
    for t in ${vorgabe//,/ }; do
      case "${t,,}" in
        karte|map|pmtiles)          TYPEN+=(karte) ;;
        routing|route|suche|search) TYPEN+=(routing) ;;
        hoehen|höhen|terrain)       TYPEN+=(hoehen) ;;
        bevoelkerung|bevölkerung|einwohner|pop) TYPEN+=(bevoelkerung) ;;
        *) warnung "Unbekannte Paketart „$t\" — überspringe sie." ;;
      esac
    done
    return 0
  fi

  # Unbeaufsichtigt und ohne Angabe: Wer LAGEBILD_LAENDER setzt, will Pakete —
  # dann die drei, die ohne weiteres Zutun bauen. Die Einwohnerdaten bleiben
  # außen vor, weil dafür erst ein 30-MB-Archiv geladen werden muss.
  if [ "$INTERAKTIV" -eq 0 ]; then
    [ -n "${LAGEBILD_LAENDER:-}" ] && TYPEN=(karte routing hoehen)
    return 0
  fi

  printf '\n'
  ja_nein "    Karte — Hintergrundkarte ohne Netz (groß, aber das Sichtbarste)?" j && TYPEN+=(karte)
  ja_nein "    Routing und Suche — Navigation, Adressen, POIs auf dem Gerät?" j && TYPEN+=(routing)
  ja_nein "    Höhen — Höhenprofil und Höhenlinien?" j && TYPEN+=(hoehen)
  ja_nein "    Einwohner — Betroffenenabschätzung für gezeichnete Flächen (lädt 30 MB Zensus-Daten)?" n && TYPEN+=(bevoelkerung)
  # Ein „nein" auf die letzte Frage wäre sonst der Rückgabewert der Funktion —
  # und mit set -e das Ende des Installers.
  return 0
}

hat_typ() {
  local t
  for t in ${TYPEN[@]+"${TYPEN[@]}"}; do [ "$t" = "$1" ] && return 0; done
  return 1
}

plan_bauen() {
  # Füllt TUN_KARTE/TUN_ROUTING/TUN_HOEHEN/TUN_BEV und SCHAETZUNG_MB.
  TUN_KARTE=(); TUN_ROUTING=(); TUN_HOEHEN=(); TUN_BEV=()
  SCHAETZUNG_MB=0
  local code neubau="${LAGEBILD_NEUBAU:-0}"

  for code in ${GEWAEHLT[@]+"${GEWAEHLT[@]}"}; do
    if hat_typ karte && { [ "$neubau" = "1" ] || ! paket_da "$code" karte; }; then
      TUN_KARTE+=("$code"); SCHAETZUNG_MB=$((SCHAETZUNG_MB + $(land_feld "$code" 3)))
    fi
    # Die Weltkarte gibt es nur als Karte — Routing, Höhen und Einwohner
    # beziehen sich immer auf ein Bundesland.
    [ "$code" = "00" ] && continue
    if hat_typ routing && { [ "$neubau" = "1" ] || ! paket_da "$code" routing; }; then
      TUN_ROUTING+=("$code"); SCHAETZUNG_MB=$((SCHAETZUNG_MB + $(land_feld "$code" 4)))
    fi
    if hat_typ hoehen && { [ "$neubau" = "1" ] || ! paket_da "$code" hoehen; }; then
      TUN_HOEHEN+=("$code"); SCHAETZUNG_MB=$((SCHAETZUNG_MB + $(land_feld "$code" 5)))
    fi
    if hat_typ bevoelkerung && { [ "$neubau" = "1" ] || ! paket_da "$code" bevoelkerung; }; then
      TUN_BEV+=("$code"); SCHAETZUNG_MB=$((SCHAETZUNG_MB + 1))
    fi
  done
}

plan_zeigen() {
  local pbf=0 code
  printf '\n'
  [ ${#TUN_KARTE[@]}   -gt 0 ] && info "Karte:          ${TUN_KARTE[*]}"
  [ ${#TUN_ROUTING[@]} -gt 0 ] && info "Routing+Suche:  ${TUN_ROUTING[*]}"
  [ ${#TUN_HOEHEN[@]}  -gt 0 ] && info "Höhen:          ${TUN_HOEHEN[*]}"
  [ ${#TUN_BEV[@]}     -gt 0 ] && info "Einwohner:      ${TUN_BEV[*]}"

  for code in ${TUN_ROUTING[@]+"${TUN_ROUTING[@]}"}; do
    pbf=$((pbf + $(land_feld "$code" 4) * 5))
  done

  printf '\n'
  info "Ergebnis auf der Platte:  rund $(mb_lesbar "$SCHAETZUNG_MB")"
  if [ "$pbf" -gt 0 ]; then
    info "Dazu vorübergehend:       rund $(mb_lesbar "$pbf") OSM-Auszüge in $ZIEL/.cache/osm"
    leise "(mit LAGEBILD_PBF_BEHALTEN=0 werden sie nach dem Bauen gelöscht)"
  fi
  if [ ${#TUN_BEV[@]} -gt 0 ]; then
    info "Dazu einmalig:            rund 150 MB Zensus-Gitter in $ZIEL/.cache/zensus"
  fi
  info "Dauer: die Karte lädt zügig, ein großes Land beim Routing braucht 10–40 Minuten."
}

platz_pruefen() {
  local noetig="$1" frei
  frei="$(frei_mb "$MAPS_DIR")"
  [ -n "$frei" ] || return 0
  if [ "$frei" -lt "$noetig" ]; then
    warnung "Nur $(mb_lesbar "$frei") frei, gebraucht werden etwa $(mb_lesbar "$noetig")."
    ja_nein "Trotzdem anfangen?" n || return 1
  fi
  return 0
}

speicher_pruefen() {
  # Der Routing-Bau startet sich mit 6 GB Heap neu — auf einer kleinen Maschine
  # endet das im OOM-Killer, und zwar nach einer halben Stunde Arbeit.
  local code speicher gross=''
  [ ${#TUN_ROUTING[@]} -gt 0 ] || return 0
  for code in "${TUN_ROUTING[@]}"; do
    case " $GROSSE_LAENDER " in *" $code "*) gross="$gross $code" ;; esac
  done
  [ -n "$gross" ] || return 0
  speicher="$(speicher_mb)"
  [ "$speicher" -ge 7000 ] && return 0
  warnung "Für$gross braucht der Routing-Bau bis zu 6 GB; vorhanden sind $(mb_lesbar "$speicher") (mit Auslagerung)."
  warnung "Ohne genug Speicher bricht der Bau mitten im Lauf ab. Abhilfe: Auslagerungsdatei anlegen."
  ja_nein "Trotzdem versuchen?" n || return 1
  return 0
}

FEHLGESCHLAGEN=()

lauf() {
  # lauf <Beschriftung> <Befehl…> — bricht den Installer nicht ab. Ein
  # misslungenes Land soll die anderen nicht kosten. Was am Ende wirklich fehlt,
  # sagt nicht der Rückgabewert, sondern ergebnis_pruefen.
  local was="$1"; shift
  printf '\n%s--%s %s\n' "$GRUEN" "$AUS" "$was"
  als_nutzer "$@" || { warnung "$was ist mit einem Fehler beendet worden."; return 1; }
  return 0
}

ZENSUS_CSV=''

zensus_bereitstellen() {
  # Setzt ZENSUS_CSV. Die Meldungen gehören auf den Bildschirm, nicht in eine
  # Variable — deshalb ein globaler Wert statt einer Ausgabe auf stdout.
  local ordner="$ZIEL/.cache/zensus" csv
  csv="$ordner/$ZENSUS_CSV_NAME"
  ZENSUS_CSV=''
  if [ -s "$csv" ]; then ZENSUS_CSV="$csv"; info "Zensus-Gitter liegt schon in $ordner"; return 0; fi

  if ! command -v unzip >/dev/null 2>&1; then
    warnung "Für das Zensus-Gitter wird „unzip\" gebraucht."
    werkzeug_nachlegen unzip || { warnung "Ohne unzip keine Einwohnerpakete."; return 1; }
  fi

  als_nutzer mkdir -p "$ordner"
  info "Zensus-Gitter wird geladen (rund 20 MB gepackt, 150 MB entpackt) …"
  als_nutzer curl -fL -# --retry 3 --retry-delay 2 -o "$ordner/zensus.zip" "$ZENSUS_URL" || {
    warnung "Download fehlgeschlagen: $ZENSUS_URL"
    return 1
  }
  als_nutzer unzip -o -q "$ordner/zensus.zip" "$ZENSUS_CSV_NAME" -d "$ordner" || {
    warnung "Das Archiv enthält „$ZENSUS_CSV_NAME\" nicht — Quelle geändert?"
    return 1
  }
  als_nutzer rm -f "$ordner/zensus.zip"
  [ -s "$csv" ] || return 1
  ZENSUS_CSV="$csv"
}

datenpakete() {
  schritt "Offline-Pakete"

  info "Ohne diese Dateien braucht die App für Karte, Suche und Route das Netz."
  info "Mit ihnen rechnet sie auf dem Gerät — dafür lädt der Browser sie einmal"
  info "über den „Offline\"-Knopf aus $MAPS_DIR."
  printf '\n'
  uebersicht_zeigen
  printf '\n'

  if [ "$INTERAKTIV" -eq 0 ] && [ -z "${LAGEBILD_LAENDER:-}" ]; then
    info "Kein Terminal und kein LAGEBILD_LAENDER gesetzt — es wird nichts gebaut."
    info "Später nachholen: bash install.sh pakete"
    return 0
  fi

  if [ "$INTERAKTIV" -eq 1 ] && [ -z "${LAGEBILD_LAENDER:-}" ]; then
    ja_nein "    Jetzt Offline-Pakete bauen?" j || {
      info "Übersprungen. Später nachholen: bash install.sh pakete"
      return 0
    }
    printf '\n'
    info "Welche Länder? Die Codes stehen links in der Tabelle."
    info "Wer nur eine Gegend braucht, nimmt sein Land und die Nachbarn dazu."
  fi

  # In der Paket-Betriebsart hat die Prüfung von node nicht stattgefunden.
  NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
  [ -n "$NODE_BIN" ] || { warnung "Ohne Node.js lassen sich keine Pakete bauen."; return 0; }

  laender_abfragen
  if [ ${#GEWAEHLT[@]} -eq 0 ]; then
    info "Keine Länder gewählt — es wird nichts gebaut."
    return 0
  fi

  typen_abfragen
  if [ ${#TYPEN[@]} -eq 0 ]; then
    info "Keine Paketart gewählt — es wird nichts gebaut."
    return 0
  fi

  plan_bauen
  local gesamt=$(( ${#TUN_KARTE[@]} + ${#TUN_ROUTING[@]} + ${#TUN_HOEHEN[@]} + ${#TUN_BEV[@]} ))
  if [ "$gesamt" -eq 0 ]; then
    info "Alles Gewählte ist schon da. (Mit LAGEBILD_NEUBAU=1 wird es neu gebaut.)"
    return 0
  fi

  plan_zeigen
  platz_pruefen "$SCHAETZUNG_MB" || return 0
  speicher_pruefen || return 0
  printf '\n'
  ja_nein "    So bauen?" j || { info "Abgebrochen — nichts gebaut."; return 0; }

  als_nutzer mkdir -p "$MAPS_DIR"

  local nice_cmd=()
  command -v nice >/dev/null 2>&1 && nice_cmd=(nice -n 10)

  # --- Karte -------------------------------------------------------------
  if [ ${#TUN_KARTE[@]} -gt 0 ]; then
    lauf "Karte: ${TUN_KARTE[*]}" env \
      OUT_DIR="$MAPS_DIR" MAXZOOM="${LAGEBILD_MAXZOOM:-14}" \
      ${nice_cmd[@]+"${nice_cmd[@]}"} bash "$ZIEL/scripts/build-maps.sh" "${TUN_KARTE[@]}" || true
    ergebnis_pruefen karte "${TUN_KARTE[@]}" || true
  fi

  # --- Routing und Suche -------------------------------------------------
  # Land für Land, damit ein Fehlschlag bei Bayern nicht Bremen mitnimmt.
  local code
  for code in ${TUN_ROUTING[@]+"${TUN_ROUTING[@]}"}; do
    lauf "Routing+Suche: $code $(land_feld "$code" 2)" env \
      OUT_DIR="$MAPS_DIR" PBF_DIR="$ZIEL/.cache/osm" \
      KEEP_PBF="${LAGEBILD_PBF_BEHALTEN:-1}" \
      ${nice_cmd[@]+"${nice_cmd[@]}"} "$NODE_BIN" "$ZIEL/scripts/build-routing.mjs" "$code" || true
    ergebnis_pruefen routing "$code" || true
  done

  # --- Höhen -------------------------------------------------------------
  for code in ${TUN_HOEHEN[@]+"${TUN_HOEHEN[@]}"}; do
    lauf "Höhen: $code $(land_feld "$code" 2)" env \
      TERRAIN_CACHE="$ZIEL/.cache/terrain" \
      ${nice_cmd[@]+"${nice_cmd[@]}"} "$NODE_BIN" "$ZIEL/scripts/build-terrain.mjs" \
      --out "$MAPS_DIR" --zoom "${LAGEBILD_HOEHEN_ZOOM:-10}" "$code" || true
    ergebnis_pruefen hoehen "$code" || true
  done

  # --- Einwohner ---------------------------------------------------------
  # In einem Lauf für alle Länder: die 130-MB-CSV wird dabei nur einmal gelesen.
  if [ ${#TUN_BEV[@]} -gt 0 ]; then
    if zensus_bereitstellen && [ -n "$ZENSUS_CSV" ]; then
      lauf "Einwohner: ${TUN_BEV[*]}" env \
        ${nice_cmd[@]+"${nice_cmd[@]}"} "$NODE_BIN" "$ZIEL/scripts/build-population.mjs" \
        --csv "$ZENSUS_CSV" --out "$MAPS_DIR" "${TUN_BEV[@]}" || true
    else
      warnung "Einwohnerpakete übersprungen — das Zensus-Gitter ließ sich nicht bereitstellen."
    fi
    ergebnis_pruefen bevoelkerung "${TUN_BEV[@]}" || true
  fi

  $SUDO chown -R "$NUTZER":"$NUTZER" "$MAPS_DIR" "$ZIEL/.cache" 2>/dev/null || true

  printf '\n'
  schritt "Stand der Pakete"
  uebersicht_zeigen

  # Die OSM-Auszüge werden nur zum Bauen gebraucht und liegen danach als
  # mehrere GB herum. Wegräumen ist eine Entscheidung, kein Automatismus:
  # ein zweiter Lauf für dasselbe Land wäre sonst wieder ein Download.
  if [ -d "$ZIEL/.cache/osm" ]; then
    local cache_mb
    cache_mb="$(du -sm "$ZIEL/.cache/osm" 2>/dev/null | cut -f1)"
    if [ -n "$cache_mb" ] && [ "$cache_mb" -gt 200 ]; then
      printf '\n'
      info "In $ZIEL/.cache/osm liegen $(mb_lesbar "$cache_mb") OSM-Auszüge."
      if ja_nein "    Jetzt löschen? (Nur für einen erneuten Bau nötig)" n; then
        $SUDO rm -rf "$ZIEL/.cache/osm"
        info "gelöscht"
      fi
    fi
  fi

  if [ ${#FEHLGESCHLAGEN[@]} -gt 0 ]; then
    printf '\n'
    warnung "Nicht fertig geworden:"
    local f
    for f in "${FEHLGESCHLAGEN[@]}"; do warnung "  $f"; done
    warnung "Noch einmal versuchen: bash install.sh pakete"
  fi
}

# ------------------------------------------------------------------ Schluss

lan_adresse() {
  local ip=''
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="src") print $(i+1); exit}')"
  printf '%s' "$ip"
}

abschluss() {
  local ip fehlt='' stand
  ip="$(lan_adresse)"
  # Nach dem Lauf soll schwarz auf weiß dastehen, was jetzt läuft.
  stand="${JETZT_TEXT:-$(stand_text HEAD 2>/dev/null || true)}"

  [ -d "$ZIEL/apps/web/dist/basemaps/fonts" ] || fehlt="${fehlt}  • Kartenschriften (pnpm assets:karte, dann neu bauen)\n"
  [ -f "$ZIEL/apps/web/dist/hazmat.json" ]    || fehlt="${fehlt}  • hazmat.json für die Gefahrgut-Ebene (scripts/build-hazmat.mjs)\n"
  ls "$MAPS_DIR"/*.pmtiles >/dev/null 2>&1    || fehlt="${fehlt}  • Kartendaten — ohne sie bleibt die Karte leer (bash install.sh pakete)\n"
  ls "$MAPS_DIR"/*.route   >/dev/null 2>&1    || fehlt="${fehlt}  • Routing und Suche ohne Netz (bash install.sh pakete)\n"

  printf '\n%s%sFertig.%s\n\n' "$GRUEN" "$FETT" "$AUS"
  printf '  Oberfläche      http://127.0.0.1:%s\n' "$PORT"
  [ -n "$ip" ] && [ "$HOST" != "127.0.0.1" ] && printf '                  http://%s:%s  (im Netz)\n' "$ip" "$PORT"
  cat <<ENDE
  Verzeichnis     $ZIEL
  Konfiguration   $ENV_DATEI
  Pakete          $MAPS_DIR
  Dienst          systemctl status $DIENST
  Protokoll       journalctl -u $DIENST -f

  Aktualisieren   dasselbe Skript noch einmal aufrufen
  Nur Pakete      bash install.sh pakete
ENDE

  if [ -n "$stand" ]; then
    printf '\n%sLäuft jetzt:%s  %s\n' "$FETT" "$AUS" "$stand"
  fi

  if [ -n "$fehlt" ]; then
    printf '\n%sNoch offen:%s\n' "$FETT" "$AUS"
    printf '%b' "$fehlt"
  fi

  printf '\n%sNicht vergessen:%s\n' "$FETT" "$AUS"
  printf '  • TLS davorschalten (Reverse-Proxy). Ohne HTTPS geht das Passwort\n'
  printf '    im Klartext über die Leitung — und der Browser verweigert über eine\n'
  printf '    nackte IP-Adresse den eigenen Speicher: Ohne HTTPS lassen sich weder\n'
  printf '    Regionen ins Gerät laden noch die App installieren.\n'
  if [ -z "$(env_lesen TRUST_PROXY 2>/dev/null)" ]; then
    printf '  • %sSteht schon ein Proxy davor?%s Dann gehört seine Adresse in\n' "$FETT" "$AUS"
    printf '    TRUST_PROXY (%s). Ohne sie sieht der Server für jeden Nutzer\n' "$ENV_DATEI"
    printf '    dieselbe Absenderadresse: Ein Fremder sperrt mit fünf falschen\n'
    printf '    Passwörtern jeden aus, und das Anmelde-Cookie bekommt kein „Secure".\n'
  fi
  if [ "$HOST" = "0.0.0.0" ]; then
    printf '  • Port %s ist auf allen Schnittstellen offen — also auch am Proxy\n' "$PORT"
    printf '    vorbei. Wenn das nicht gewollt ist, in der Firewall nur den Proxy\n'
    printf '    zulassen (oder HOST=127.0.0.1, falls der Proxy hier mitläuft).\n'
  fi
  printf '  • Die Karte selbst kommt ohne all das aus: Der Server liefert die\n'
  printf '    Kacheln aus %s aus, sobald dort Pakete liegen.\n' "$MAPS_DIR"
  printf '  • In der App unter „Offline" die gewünschten Regionen ins Gerät laden —\n'
  printf '    auf dem Server liegen sie, im Browser brauchen sie einen Klick.\n\n'
}

# ------------------------------------------------------------------ Ablauf

hilfe() {
  # Über „curl … | bash" gibt es keine Datei zum Nachlesen — dann das Nötigste.
  if [ -r "${0:-}" ] && head -1 "$0" 2>/dev/null | grep -q '^#!'; then
    sed -n '2,42p' "$0" | sed 's/^#//; s/^ //'
  else
    cat <<'KURZ'
install.sh — Lagebild einrichten, aktualisieren und mit Daten füllen.

  bash install.sh            einrichten bzw. aktualisieren, dann Offline-Pakete
  bash install.sh pakete     nur die Offline-Pakete bauen
  bash install.sh hilfe      diese Übersicht

Umgebungsvariablen: LAGEBILD_DIR, LAGEBILD_BRANCH, LAGEBILD_FORCE,
LAGEBILD_LAENDER, LAGEBILD_PAKETE, LAGEBILD_NEUBAU, LAGEBILD_PBF_BEHALTEN,
LAGEBILD_MAXZOOM, LAGEBILD_HOEHEN_ZOOM.
Ausführlich im Kopf der Datei: https://github.com/FelixLenz-Code/lagebild/blob/main/install.sh
KURZ
  fi
  exit 0
}

MODUS='voll'
case "${1:-}" in
  ''|voll) MODUS='voll' ;;
  pakete|--pakete) MODUS='pakete' ;;
  hilfe|--hilfe|-h|--help) hilfe ;;
  *) fehler "Unbekannter Aufruf „$1\". Bekannt sind: (nichts), pakete, hilfe." ;;
esac

if [ "$MODUS" = 'pakete' ]; then
  # Nur Pakete: die App bleibt, wie sie ist. Trotzdem alles prüfen, was für den
  # Bau gebraucht wird.
  [ -d "$ZIEL/.git" ] || fehler "$ZIEL sieht nicht nach einer Installation aus. Erst „bash install.sh\" ausführen."
  command -v node >/dev/null 2>&1 || fehler "Node.js fehlt."
  NODE_BIN="$(command -v node)"
  ARBEITS_ENV="$ARBEIT/env"
  : > "$ARBEITS_ENV"; chmod 600 "$ARBEITS_ENV"
  $SUDO cat "$ENV_DATEI" > "$ARBEITS_ENV" 2>/dev/null || true
  PORT="$(env_lesen PORT)"; PORT="${PORT:-8787}"
  HOST="$(env_lesen HOST)"; HOST="${HOST:-0.0.0.0}"
  MAPS_DIR="$(env_lesen MAPS_DIR)"; MAPS_DIR="${MAPS_DIR:-$ZIEL/apps/api/maps}"
  datenpakete
  abschluss
  exit 0
fi

pruefen
nutzer_anlegen
quellcode
konfiguration
bauen_mit_rueckweg
dienst
probe
datenpakete
abschluss
