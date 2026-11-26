# Viewdeck auf dem eigenen Linux-Server
Die Docker-Version nutzt SQLite auf deinem Server. Dateien, Sammlungen, View-Codes und Sitzungen liegen im Docker-Volume `viewdeck_data`. Zuschauer öffnen eine Datei per Code. Für Uploads meldet man sich über Google oder Discord an. Der ChatGPT-Login gehört zur Sites-Version.

## 1. Projekt holen
Du brauchst Git, Bash, flock (util-linux), Docker Engine und Docker Compose mit Unterstützung für `up --wait`. Führe die Befehle auf deinem Server mit einem Benutzer aus, der Docker verwenden darf.

```bash
sudo mkdir -p /srv/web-hosting
sudo install -d -m 0755 -o "$(id -un)" -g "$(id -gn)" /srv/web-hosting/Viewdeck
git clone https://github.com/xLordTime/viewdeck.git /srv/web-hosting/Viewdeck
cd /srv/web-hosting/Viewdeck
(umask 077; cp .env.example .env)
nano .env
```

Die Befehle oben gelten für die Erstinstallation in einem leeren Zielordner. Liegt das Repository bereits unter `/srv/web-hosting/Viewdeck/`, gehe direkt zu Abschnitt 4. Eine vorhandene `.env` kannst du mit `nano /srv/web-hosting/Viewdeck/.env` bearbeiten.

## 2. Adresse und Anmeldung eintragen
Setze `PUBLIC_ORIGIN` auf deine tatsächliche öffentliche HTTPS-Adresse, beispielsweise `https://viewdeck.edle-entdecker.pro`. Wähle bei einem Portkonflikt in `VIEWDECK_PORT` einen freien lokalen Port. Trage für mindestens einen Anbieter beide Werte ein. Die Zugangsdaten bleiben in der lokalen Datei `.env`.

| Anbieter | Einrichtung | Rücksprung-Adresse bei der Beispieldomain |
|---|---|---|
| Discord | Im [Developer Portal](https://discord.com/developers/applications) eine Anwendung öffnen oder erstellen. Unter OAuth2 die Redirect-URL hinzufügen und Client ID sowie Client Secret in DISCORD_CLIENT_ID und DISCORD_CLIENT_SECRET übernehmen. | `https://viewdeck.edle-entdecker.pro/auth/discord/callback` |
| Google | In [Google Auth Platform](https://console.cloud.google.com/auth/clients) den Zustimmungsbildschirm und einen Client vom Typ Webanwendung einrichten. Bei Testbetrieb Testnutzer freischalten. Client-ID und Secret in GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET übernehmen. | `https://viewdeck.edle-entdecker.pro/auth/google/callback` |

Ersetze die Beispieldomain auch beim Anbieter. Jeder Nutzer, den ein eingerichteter Anbieter erfolgreich anmeldet, kann hochladen. Jede Person mit einem View-Code kann die dazugehörigen Originaldateien abrufen.

## 3. Starten und Domain verbinden
```bash
bash update.sh
curl -fsS http://127.0.0.1:8787/healthz
```

Der Test sollte `ok` liefern. Passe die Portnummer an, falls du sie geändert hast. Viewdeck belegt nur den lokalen Port. Leite deine Subdomain im vorhandenen HTTPS-Reverse-Proxy oder einem auf dem Host laufenden Cloudflare Tunnel an `http://127.0.0.1:8787` weiter. Für Caddy auf dem Host genügt bei korrekt eingerichtetem DNS dieser zusätzliche Block:

```caddyfile
viewdeck.edle-entdecker.pro {
    reverse_proxy 127.0.0.1:8787
}
```

Läuft der Proxy selbst in Docker, verbinde seinen Container und den Viewdeck-Dienst über ein gemeinsames Docker-Netz und verwende als Ziel den Dienstnamen `web` oder einen eindeutigen Netzalias auf Port 8080. In einem Proxy-Container verweist 127.0.0.1 auf den Proxy selbst. Stelle das Uploadlimit des Proxys auf mindestens 25 MiB pro Datei ein.

Öffne die HTTPS-Adresse, melde dich an, lade zwei Dateien hoch und teste den Gruppencode in einem privaten Browserfenster. Bei Office-Dateien startet die Vorschau per Klick. Microsoft muss den Dateilink von außen erreichen können. Ein vorgeschalteter Login vor der gesamten Domain verhindert diesen Zugriff. PDF und Bilder öffnet Viewdeck direkt.

## 4. Spätere Updates
```bash
cd /srv/web-hosting/Viewdeck
bash update.sh
```
Das Skript holt main per Fast-forward, baut zuerst das neue Image und wartet nach dem Containerwechsel auf den Healthcheck. Beim Wechsel kann die Website kurz unterbrochen sein. .env und das benannte Volume bleiben erhalten. Bei Fehlern helfen `docker compose ps -a` und `docker compose logs --tail=80 web`. Nach Änderungen an .env übernimmt ein weiterer Skriptlauf die Konfiguration.

## 5. Daten sichern
Erzeuge vor größeren Updates eine konsistente Kopie der SQLite-Datenbank. Führe dies im Projektverzeichnis aus:
```bash
umask 077
mkdir -p "$HOME/viewdeck-backups"
backup="$HOME/viewdeck-backups/viewdeck-$(date +%Y%m%d-%H%M%S).sqlite"
docker compose exec -T web node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; import fs from 'node:fs'; const p='/tmp/backup-'+process.pid; const db=new DatabaseSync('/data/viewdeck.sqlite'); db.exec(\"VACUUM INTO '\"+p+\"'\"); db.close(); fs.createReadStream(p).on('close',()=>fs.unlinkSync(p)).pipe(process.stdout)" > "$backup" && test -s "$backup"
```
Neue Uploads liegen unter /data/files. Kopiere nach dem Datenbank-Snapshot auch diese unveränderlichen Dateien in dasselbe Backup. Halte während der Sicherung das Volume verfügbar. Beispiel aus dem Projektverzeichnis:

```bash
docker compose cp web:/data/files "${backup%.sqlite}-files"
```

Für eine Wiederherstellung gehören die zugehörige Datenbank und das Dateiverzeichnis zusammen in das Datenvolume. Ältere Uploads bleiben direkt in der Datenbank lesbar.

Sichere auch .env vertraulich und kopiere beides auf einen zweiten Datenträger. Zum Stoppen genügt `docker compose stop`. Der Zusatz `-v` bei `docker compose down` löscht das Datenvolume.

## Persönliche Codes und Rollen
Nach der Anmeldung zeigt „Meine Codes“ deine Dateien und Sammlungen einschließlich früherer Uploads desselben Kontos. Unter Einstellungen kannst du Sortierung und Standardfilter pro Konto speichern. Unter „Mein Profil“ lassen sich Nickname und Bildquelle ändern sowie Google, Discord und ein lokaler Username mit Passwort am selben Konto verknüpfen. Öffne die Verknüpfung im bereits angemeldeten Konto. Bestehende getrennte Konten werden nicht automatisch zusammengeführt. Beim ersten erneuten Anbieter-Login werden Name und Bild bestehender Konten übernommen. Gravatar verwendet auf Wunsch die im Profil angegebene E-Mail-Adresse.

Die Rolle gilt pro Datei: standard 25 MiB, plus 50 MiB, pro 100 MiB, admin ohne anwendungsseitiges Dateigrößenlimit. Passe das Uploadlimit deines Reverse-Proxys an die größte genutzte Rolle an. Die Konto-ID steht unter „Meine Codes“. Rollen vergibst du ausschließlich in der Serverkonsole:

```bash
cd /srv/web-hosting/Viewdeck
docker compose exec web node server.mjs roles list
docker compose exec web node server.mjs roles set 'discord:DEINE_USER_ID' admin
```
Mit `standard` setzt du das Limit zurück. Bestehende Dateien behalten ihren Code. Lade die Seite nach einer Rollenänderung neu.
