SpoolRSS {version} for Windows
==============================

SpoolRSS is a feed reader that runs on your computer and opens in your browser.
Nothing is installed: everything stays in this folder. Keep the folder in your
own user folder (Documents, for example), where other accounts on this
computer can't change it.

Starting it
  Double-click SpoolRSS.exe. It runs in the background with an icon in the
  notification area (the tray, next to the clock; it may be under the ^ arrow).
  The first time, SpoolRSS opens in your browser.

  Click the tray icon to open SpoolRSS. Closing the browser tab leaves SpoolRSS
  running in the tray, still checking your feeds. Right-click the icon for:
    Start with Windows        starts SpoolRSS in the tray when you sign in
    Run as a Windows service  starts SpoolRSS with Windows, even before anyone
                              signs in (needs administrator permission once).
                              While it's a service, only administrators can
                              change this folder; turning it off gives it back.
    Quit                      stops SpoolRSS (a service keeps running)

  If Windows SmartScreen says it "protected your PC", click "More info" and then
  "Run anyway". SpoolRSS isn't code-signed.

Browser extension
  In the SpoolRSS extension's settings, choose SpoolRSS and enter
  http://localhost:8080 as the address.

Settings
  settings.txt (created on first run) sets the port, the network address and
  the other settings. Quit SpoolRSS and start it again after changing it.

Your data
  data\spoolrss.db holds your feeds and articles, and data\spoolrss.log is the
  log. To move SpoolRSS, quit it and move the whole folder (turn off "Run as a
  Windows service" first, and turn it on again afterwards).

Updating
  When a new version is out, SpoolRSS says so in the app and in a notification.
  Click "Update now": it downloads the new version from GitHub, checks it, and
  restarts with it. Your data and settings are kept.

More: https://github.com/tet0r/spoolrss
