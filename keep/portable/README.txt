Reliquary Keep — Portable
==========================

Your own self-hosted Reliquary server. One binary, no install, no dependencies.


QUICK START
-----------
1. Double-click  start-keep.cmd
2. On the FIRST run it prints an "admin key" in the window — SAVE IT.
   It unlocks the Host Console and cannot be shown again.
3. The Keep is now live at  http://localhost:7777
   - Host Console (manage the server):  http://localhost:7777/admin
   - The first person to join from the Reliquary client claims it as owner.

Give your friends your IP address (and the keep password / an invite if you set
one) and they connect from the Reliquary client.


YOUR DATA
---------
Everything lives right next to keep.exe:
  - keep.db        your channels, members, messages, settings
  - media/         uploaded images / files / video
Back these up to keep your server. Deleting them resets the Keep.


LETTING FRIENDS JOIN OVER THE INTERNET
--------------------------------------
Forward these on your router to this PC:
  - TCP 7777   chat, gateway, media — everything
  - UDP 7011   voice

For voice over the internet, also tell it your public IP (find it at
whatismyip.com):
  keep.exe -voice-ip <your-public-ip>

You can change the ports, name, TLS, upload limit, and more from the Host
Console once it's running (Server config), or with flags:
  keep.exe -name "My Keep" -addr :7777 -voice-port 7011

On the same network (LAN), none of this is needed — it just works.


UPDATING
--------
Download the newest "Keep-Portable" zip from the Releases page and replace
keep.exe with the new one (keep your keep.db and media/ folder).


More docs: https://github.com/HPelto/Reliquary
