# ArcTV

Home IPTV server for Samsung Smart TVs (Tizen and Orsay).

- Downloads M3U / Xtream Codes playlists and the XMLTV guide from your provider and serves them
  ready to the TVs.
- Shared favorites and saved archive positions for all TVs; per-TV settings; TV access control.
- Main, extended, PIN-protected and hidden groups, custom names and order.
- Web page inside Home Assistant (sidebar **ArcTV**, no extra password) or directly on port 18090
  with its own login.

TVs connect to `http://<Home Assistant host>:18090`. Data is kept in `addon_configs/<id>_arctv`
and included in Home Assistant backups.

See the **Documentation** tab and the
[repository README](https://github.com/MrCheng888/arctv-ha) for details.
