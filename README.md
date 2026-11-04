# ArcTV — Home Assistant add-on repository

![ArcTV](arctv/logo.png)

Home Assistant add-on repository for **ArcTV**, a home IPTV server for Samsung Smart TVs
(Tizen and the older Orsay platform). The server downloads playlists and the TV guide from your
IPTV provider, prepares them for the TVs, keeps shared favorites and saved positions, and is
managed from a web page.

## Add-ons

| Add-on | Description |
|---|---|
| [ArcTV](arctv) | Home IPTV server for Samsung TVs (Tizen and Orsay) |

## Features

- **Playlists:** several M3U or Xtream Codes sources, each with its own groups, order and favorites.
- **TV guide (XMLTV):** downloaded and parsed on the server; TVs get a small "now" slice at startup
  and the full guide in the background. Several guide sources per playlist, matching by `tvg-id`
  or channel name, time shift.
- **Groups:** main, extended, PIN-protected and hidden groups; custom group names; custom order of
  groups and channels; hidden channels.
- **Shared state:** favorites and saved archive positions are shared by all TVs; per-TV settings
  (accent color, buffering, overlay opacity, allowed group types).
- **TV access control:** a new TV must be allowed on the web page before it gets the playlist.
- **Holiday icons** shown on the TV on chosen dates (yearly, one-time, or relative to Orthodox Easter).
- **Playlist for other players:** per-playlist M3U link and file with the server's guide.
- **Web page:** inside Home Assistant (Ingress, sidebar item **ArcTV**, no extra password) or
  directly on port 18090 with its own login.

The TV app itself is not part of this repository.

## Installation

1. In Home Assistant: **Settings → Apps** (add-ons) → **App store** → ⋮ → **Repositories**.
2. Add `https://github.com/MrCheng888/arctv-ha` and close the dialog.
3. Find **ArcTV** in the store and click **Install**. Home Assistant builds the image locally
   (Node.js 24 on Alpine, takes a minute or two).
4. Enable **Start on boot** and **Watchdog**, then **Start**.
5. Open the web page with **Open web UI** or the **ArcTV** sidebar item, add a playlist in
   **Sources** and save. Channels and the TV guide appear in **Status** within seconds.

Supported architectures: `amd64`, `aarch64`.

## Connecting the TVs

The TV app needs only the server address, for example `http://192.168.1.200:18090`
(Home Assistant host IP, external port 18090). Everything else is configured on the web page and
sent to the TVs; TVs keep the last received playlist and settings and keep working when the
server is unavailable.

## Web page access

| Where | Address | Login |
|---|---|---|
| Inside Home Assistant (Ingress) | **Open web UI** / sidebar **ArcTV** | Home Assistant login only |
| Direct | `http://<HA host>:18090` | ArcTV login and password (created on first visit) |

Ingress requests are recognized by the Supervisor proxy address and the `X-Ingress-Path` header;
all other requests require the ArcTV login. TVs and other players always use the direct port.

## Data and backups

All data is stored in the add-on config folder (`/config` inside the container), visible from the
host as `addon_configs/<id>_arctv` (for example via the Samba share add-on):
`settings.json` (sources, groups, holidays, shared settings), `devices.json`, `state.json`
(favorites, saves), `auth.json`, cached playlists and
guide. It is included in Home Assistant backups.

**Moving from another ArcTV server** (for example a Docker container on a NAS): stop the add-on,
copy the contents of the old server's `data` folder into `addon_configs/<id>_arctv` (replace
files), start the add-on. Playlists, groups, TVs, favorites, saves, holidays and the web login
move over.

## Port

Port `8090` inside the container is published as **18090** on the host. It can be changed in the
add-on's **Configuration → Network**; the TVs then need the new address.

## Updating

New versions appear in Home Assistant after **App store → ⋮ → Check for updates**; then click
**Update** on the add-on page. Changes are listed in [CHANGELOG.md](arctv/CHANGELOG.md)
(in Russian).

## Repository layout

```
repository.yaml        repository metadata
arctv/
  config.yaml          add-on manifest (ports, Ingress, watchdog, config folder)
  Dockerfile           node:24-alpine + server code
  app/                 server (Node.js, no dependencies): server.js, lib/, public/index.html
  DOCS.md              documentation shown in Home Assistant (in Russian)
  CHANGELOG.md
  icon.png, logo.png
```

The same server code also runs without Home Assistant: `node app/server.js` (Node.js 18+),
with `DATA_DIR` and `PORT` environment variables.

## Notes

- The web UI and the TV app are in Russian.
- Provider credentials (playlist URLs, Xtream logins) are stored only in the add-on's data folder,
  never in this repository.
