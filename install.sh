#!/usr/bin/env bash
#
# install.sh — Lagebild einrichten und aktualisieren.
#
#   curl -fsSL https://raw.githubusercontent.com/FelixLenz-Code/lagebild/main/install.sh | bash
#
# Dasselbe Skript macht beides: Beim ersten Lauf richtet es ein, bei jedem
# weiteren holt es den neuen Stand, baut ihn und startet den Dienst durch. Was
# schon da ist, bleibt — Schlüssel, Passwort und die heruntergeladenen
# Offline-Pakete werden nie überschrieben, nur auf Nachfrage geändert.
#
# Was es anlegt:
#   /opt/lagebild                  Quellcode und gebautes Bundle
#   /opt/lagebild/apps/api/.env    Konfiguration (Schlüssel, Passwort)
#   Systemnutzer `lagebild`        ohne Login, ohne Passwort
#   lagebild.service               systemd-Dienst, Start beim Hochfahren
#
# Umgebungsvariablen für unbeaufsichtigte Läufe:
#   LAGEBILD_DIR      Zielverzeichnis (Vorgabe /opt/lagebild)
#   LAGEBILD_BRANCH   Zweig (Vorgabe main)
#   LAGEBILD_FORCE=1  verwirft eigene Änderungen im Zielverzeichnis ohne Rückfrage
#
# Ohne Terminal (etwa in einer Pipeline) fragt das Skript nichts und behält
# alle vorhandenen Werte.

set -Eeuo pipefail

REPO="${LAGEBILD_REPO:-https://github.com/FelixLenz-Code/lagebild.git}"
ZWEIG="${LAGEBILD_BRANCH:-main}"
ZIEL="${LAGEBILD_DIR:-/opt/lagebild}"
NUTZER="lagebild"
DIENST="lagebild"
ENV_DATEI="$ZIEL/apps/api/.env"
MIN_NODE=20

# ------------------------------------------------------------------ Ausgabe

if [ -t 1 ]; then
  ROT=$'\033[31m'; GRUEN=$'\033[32m'; GELB=$'\033[33m'; FETT=$'\033[1m'; AUS=$'\033[0m'
else
  ROT=''; GRUEN=''; GELB=''; FETT=''; AUS=''
fi

schritt() { printf '\n%s==>%s %s%s\n' "$GRUEN" "$AUS" "$FETT" "$1$AUS"; }
info()    { printf '    %s\n' "$1"; }
warnung() { printf '%s !  %s%s\n' "$GELB" "$1" "$AUS" >&2; }
fehler()  { printf '\n%sFehler: %s%s\n' "$ROT" "$1" "$AUS" >&2; exit 1; }

# Bricht etwas ab, soll klar sein wo — sonst sucht man in 300 Zeilen.
trap 'st=$?; [ $st -ne 0 ] && printf "\n%sAbgebrochen in Zeile %s (Status %s).%s\n" "$ROT" "$LINENO" "$st" "$AUS" >&2; exit $st' ERR

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
  # COREPACK_ENABLE_DOWNLOAD_PROMPT: corepack will das Nachladen von pnpm sonst
  # bestätigt haben — und wartet als Dienstnutzer ohne Terminal endlos darauf.
  "${WECHSEL[@]}" env HOME="$ZIEL" PATH="$PATH" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1 "$@"
}

# ------------------------------------------------------------------ Prüfungen

schritt "Voraussetzungen prüfen"

for werkzeug in git curl; do
  command -v "$werkzeug" >/dev/null 2>&1 || fehler "„$werkzeug\" fehlt. Nachinstallieren, z.B. mit: apt install $werkzeug"
done

command -v systemctl >/dev/null 2>&1 || fehler "Dieses Skript richtet einen systemd-Dienst ein; systemctl wurde nicht gefunden."

command -v node >/dev/null 2>&1 || fehler "Node.js fehlt. Nötig ist Fassung $MIN_NODE oder neuer — siehe https://nodejs.org/de/download/package-manager"
NODE_BIN="$(command -v node)"
NODE_FASSUNG="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_FASSUNG" -ge "$MIN_NODE" ] || fehler "Node.js $NODE_FASSUNG ist zu alt, nötig ist $MIN_NODE oder neuer."
info "Node.js $(node -v) unter $NODE_BIN"

# Ein Node aus nvm liegt im Heimverzeichnis eines Menschen. Der Dienstnutzer
# kommt da unter Umständen nicht heran, und beim nächsten nvm-Wechsel zeigt der
# Pfad ins Leere.
case "$NODE_BIN" in
  /home/*|/root/*|*/.nvm/*)
    warnung "Node liegt unter $NODE_BIN — das ist eine Installation im Heimverzeichnis (nvm o.ä.)."
    warnung "Der Dienst läuft als Nutzer „$NUTZER\" und braucht ein systemweites Node (/usr/bin/node)."
    ja_nein "Trotzdem weitermachen?" n || exit 1
    ;;
esac

if command -v pnpm >/dev/null 2>&1; then
  info "pnpm $(pnpm --version)"
else
  info "pnpm fehlt — wird über corepack bereitgestellt"
  $SUDO corepack enable pnpm >/dev/null 2>&1 || fehler "corepack konnte pnpm nicht bereitstellen. Von Hand: npm install -g pnpm"
fi

# ------------------------------------------------------------------ Nutzer

schritt "Systemnutzer „$NUTZER\""

if id "$NUTZER" >/dev/null 2>&1; then
  info "vorhanden"
else
  $SUDO useradd --system --home-dir "$ZIEL" --shell /usr/sbin/nologin "$NUTZER"
  info "angelegt (kein Login, kein Passwort)"
fi

# ------------------------------------------------------------------ Quellcode

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
  als_nutzer git -C "$ZIEL" fetch --depth 1 origin "$ZWEIG"
  als_nutzer git -C "$ZIEL" checkout -q -B "$ZWEIG" "origin/$ZWEIG"
  info "aktualisiert auf $(als_nutzer git -C "$ZIEL" rev-parse --short HEAD)"
else
  # Ein nicht leeres Verzeichnis ohne .git ist nichts, worin man klonen will.
  if [ -n "$($SUDO ls -A "$ZIEL" 2>/dev/null || true)" ]; then
    fehler "$ZIEL ist nicht leer, enthält aber kein Git-Verzeichnis. Bitte prüfen und leeren."
  fi
  als_nutzer git clone --depth 1 --branch "$ZWEIG" "$REPO" "$ZIEL"
  info "geklont nach $ZIEL"
fi

# ------------------------------------------------------------------ .env
#
# Bestehende Werte lesen, zeigen (maskiert) und auf Wunsch ändern. Enter behält,
# ein einzelner Bindestrich löscht.

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
ARBEITS_ENV="$(mktemp)"
chmod 600 "$ARBEITS_ENV"
aufraeumen() { rm -f "$ARBEITS_ENV"; }
trap aufraeumen EXIT
$SUDO cat "$ENV_DATEI" > "$ARBEITS_ENV" 2>/dev/null || true

env_lesen() {
  awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$ARBEITS_ENV"
}

env_setzen() {
  # Schlüssel und Wert kommen über die Umgebung, damit awk in keinem von beiden
  # Sonderzeichen deutet.
  local schluessel="$1" wert="$2" tmp
  tmp="$(mktemp)"
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

abfragen TOMTOM_KEY     "Verkehrsfluss (TomTom)"       "leer lassen: Ebene bleibt ausgeblendet"
abfragen AISSTREAM_KEY  "Schiffsverkehr (aisstream.io)" "kostenlos nach Anmeldung"
abfragen APRSFI_KEY     "Amateurfunk (aprs.fi)"        "eigener Schlüssel je Nutzer"
abfragen APP_PASSWORD   "Passwort vor dem Server"      "leer: offen für alle. Nur mit HTTPS sinnvoll." -s

# Pfade fest eintragen: Der Dienst startet in apps/api, das gebaute Bundle
# liegt aber in apps/web/dist. Ohne diese beiden Zeilen liefert der Server nur
# die Schnittstelle aus, nicht die Oberfläche.
env_setzen WEB_ROOT "$ZIEL/apps/web/dist"
env_setzen MAPS_DIR "$ZIEL/apps/api/maps"
env_sichern

PORT="$(env_lesen PORT)"; PORT="${PORT:-8787}"

# ------------------------------------------------------------------ Bauen

schritt "Abhängigkeiten und Bau"

als_nutzer pnpm --dir "$ZIEL" install --frozen-lockfile
info "Abhängigkeiten installiert"
als_nutzer pnpm --dir "$ZIEL" -r build
info "gebaut"

[ -f "$ZIEL/apps/api/dist/index.js" ] || fehler "Der Bau hat keine apps/api/dist/index.js erzeugt."
[ -f "$ZIEL/apps/web/dist/index.html" ] || fehler "Der Bau hat kein Web-Bundle erzeugt."

$SUDO chown -R "$NUTZER":"$NUTZER" "$ZIEL"

# ------------------------------------------------------------------ Dienst

schritt "systemd-Dienst"

# ProtectHome sperrt dem Dienst /home. Liegt das Ziel dort, muss die Sperre
# gelockert werden — sonst findet der Dienst sein eigenes Verzeichnis nicht.
case "$ZIEL" in
  /home/*|/root/*) SCHUTZ_HOME='read-only' ;;
  *)               SCHUTZ_HOME='true' ;;
esac

UNIT="/etc/systemd/system/$DIENST.service"
tmp_unit="$(mktemp)"
cat > "$tmp_unit" <<UNITENDE
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
ProtectSystem=strict
ProtectHome=$SCHUTZ_HOME
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=$ZIEL

[Install]
WantedBy=multi-user.target
UNITENDE

$SUDO cp "$tmp_unit" "$UNIT"
rm -f "$tmp_unit"
$SUDO chmod 644 "$UNIT"
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$DIENST" >/dev/null 2>&1
$SUDO systemctl restart "$DIENST"
info "$DIENST.service eingerichtet und gestartet"

# ------------------------------------------------------------------ Probe

schritt "Probe"

erreichbar=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    erreichbar=1; break
  fi
  sleep 1
done

if [ "$erreichbar" -eq 1 ]; then
  info "Der Server antwortet auf http://127.0.0.1:$PORT/api/health"
else
  warnung "Der Server antwortet nicht auf Port $PORT."
  warnung "Protokoll ansehen mit:  journalctl -u $DIENST -n 50 --no-pager"
  exit 1
fi

# ------------------------------------------------------------------ Schluss

cat <<ENDE

${GRUEN}${FETT}Fertig.${AUS}

  Oberfläche      http://127.0.0.1:$PORT
  Verzeichnis     $ZIEL
  Konfiguration   $ENV_DATEI
  Dienst          systemctl status $DIENST
  Protokoll       journalctl -u $DIENST -f

  Aktualisieren   dasselbe Skript noch einmal aufrufen

${FETT}Noch zu tun:${AUS}
  • TLS davorschalten (Reverse-Proxy). Ohne HTTPS geht das Passwort
    im Klartext über die Leitung.
  • Offline-Pakete bauen, wenn Karte, Routing und Suche ohne Netz
    laufen sollen:  cd $ZIEL && sudo -u $NUTZER scripts/build-routing.mjs 04

ENDE
