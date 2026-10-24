# MVV4Dummies

Fahrtbegleiter fürs iPhone (Web-App) für S-Bahn, U-Bahn, Tram und Bus im MVV.

Du sitzt im Zug, die App weiß per GPS, wo du bist, und beantwortet:

- **Welcher Zug ist meiner?** Er wird automatisch über GPS-Position und Echtzeit zugeordnet.
  Hast du einen Zug später genommen, merkt sie das selbst.
- **Was kommt als Nächstes?** Die nächsten Halte mit Verspätung, dazu eine Karte.
- **Ist etwas gestört?** Störungsmeldungen zu deiner Linie und deinen Halten.
- **Lohnt sich Umsteigen?** An den nächsten 3 Halten wird geprüft, ob Aussteigen schneller ist.
  Dazu siehst du, was es kostet, den Anschluss zu verpassen (zum Beispiel „+5 min, nächste U-Bahn“).
  Das passiert automatisch bei Störung, Ausfall oder ab 5 min Verspätung, sonst per Knopf „Prüfen“.

## Aufs iPhone bringen

1. GitHub-Pages für dieses Repository einschalten (siehe unten).
2. Die Seite in **Safari** öffnen → Teilen → **Zum Home-Bildschirm**.
3. Beim ersten Start „Fahrt“ antippen und den Standort erlauben.

### GitHub Pages einschalten

Repository auf github.com → **Settings** → **Pages** → *Source*: „Deploy from a branch“ →
Branch auswählen, Ordner `/ (root)` → **Save**. Nach ein bis zwei Minuten läuft die App unter
`https://<github-name>.github.io/MVV4Dummies/`.

## Grenzen (ehrlich gesagt)

- **Nur im Vordergrund:** iOS lässt Web-Apps den Standort nur nutzen, solange die App offen ist.
  Eine Benachrichtigung bei gesperrtem Bildschirm braucht später eine echte iOS-App oder Web-Push.
- **Datenquelle inoffiziell:** Die App nutzt die Schnittstelle hinter mvg.de. Sie ist nicht offiziell
  für Dritte freigegeben und kann sich jederzeit ändern.
- **Prognosen bei Störungen sind oft schlecht.** Die Empfehlung kann nie besser sein als die
  Echtzeitdaten. Deshalb zeigt die App bei jeder Alternative das Risiko eines verpassten Anschlusses.
- **Kein GPS im Tunnel** (z. B. Stammstrecke): Dort wird die Position aus der Echtzeit geschätzt.

## Technik

Reines HTML/CSS/JavaScript ohne Build-Schritt. Karte: [Leaflet](https://leafletjs.com) 1.9.4
(liegt in `vendor/`) mit OpenStreetMap-Kacheln. Favoriten werden nur lokal im Browser gespeichert.

Lokal testen: `python3 -m http.server` und `http://localhost:8000/?pos=48.11,11.596` öffnen.
`?pos=` simuliert einen Standort, hier Giesing.
