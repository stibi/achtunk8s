# Shot list

Screenshots and clips the README references (and the website reuses). Each is captured
from the macOS app in demo mode, so only made-up data is visible: instances `eu-prod`,
`us-prod` and `staging`, links to example.com. Never capture a real server.

## General rules

- **Start the demo:** `make demo` (dark mode, the system default here) or
  `macos/scripts/demo.sh -NSRequiresAquaSystemAppearance YES` (light mode). The demo's
  read state and notification state are written fresh each run and removed on quit, so
  every run starts the same way. A new critical alert (`CheckoutLatencyHigh`, us-prod)
  fires 45 s in, and `CardAuthorisationsFailing` resolves after 2.5 minutes.
- **Make things happen now** (from another terminal while the demo runs):
  - `curl -X POST 'http://127.0.0.1:8790/demo/fire?count=1'`: new critical alerts
    (`count=4` for a summary notification).
  - `curl -X POST http://127.0.0.1:8790/demo/resend`: resend the newest firing alert.
  - `curl -X POST http://127.0.0.1:8790/demo/remind`: every pending reminder comes due.
    Without it, the reminder on `CertificateExpiringSoon` (eu-prod) comes due 90 s in, and
    `BackupJobFailed` (eu-prod) keeps one pending.
- **Appearance:** light mode for every still and clip, so the set matches. The hero tour
  (`achtung-demo.gif`) is the exception and stays as recorded.
- **Window:** 1440 × 900 points for the main window (stills at 2×, i.e. 2880 × 1800
  pixels, are fine for PNGs). Nothing else on screen: hide the Dock and other windows,
  use a plain desktop. Capture the window with its shadow off (`⇧⌘4`, Space, ⌥-click),
  except the notification and menu bar shots, which need a region of the screen.
- **Stills:** PNG, at most 1 MB each (`pngquant` or `oxipng` if larger).
- **Clips:** 5 to 15 s, one action each. Record an MP4 (H.264, 30 fps), and make the GIF
  from it at 960 px wide, 12 to 15 fps, at most 3 MB. The README embeds the GIF; keep the
  MP4 beside it under the same name.
  ```bash
  ffmpeg -i search.mp4 -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer" search.gif
  ```
- Animated features also get a PNG still under the same name (`search.png` next to
  `search.gif`) for the website.

## Shots

| File | Shows | Steps |
|---|---|---|
| `achtung-demo.gif`, `.mp4` | The 43 s tour. **Exists**, keep. | — |
| `home.png` | Home: the three Alertmanager tiles (eu-prod with a delivery warning and a healthy IRM heart, us-prod with the IRM heart missing, staging without IRM), then silences ending soon, noisiest and longest firing. | `make demo`, wait until the tiles load. Home opens first. |
| `alert-detail.png` | A channel's list with one alert open: summary, description, link buttons, labels one per row, and on the right the events and the alert's other occurrences. Copy for Agent visible. | Sidebar: eu-prod › platform, open `KubePodCrashLooping` (it has a description and an earlier occurrence two days ago). |
| `resent.png` | A resent alert: circular arrow in the list row, "Resent 14:05" pill in the header. | The scenario already has resent alerts (anything firing for over an hour, e.g. eu-prod › payments › `PaymentsQueueBacklog`). For a fresh one, `curl -X POST http://127.0.0.1:8790/demo/resend` resends the newest firing alert; wait up to 30 s and open it. |
| `live.png` | Live: a queue of collapsed one-line cards from several channels with one card expanded (its details, buttons and labels), beside the 24-hour timeline with markers and severity bars. The coffee break is **not** showing (there are unread cards). | Sidebar: Live, about a minute in (after `CheckoutLatencyHigh` fires). Click the third card to expand it, so two collapsed ones stay above it, then scroll to the top. Hover nothing. The Mac mini's screen fits a window only 796 points high, so the current still is 2880 × 1592. |
| `silence.gif` (+ `.png`, `.mp4`) | Silence button's menu → pick 4h → header shows "Silenced until …" → the Silenced menu with Change and End Silence. Still: the open menu. | Open us-prod › platform › `TargetDown`, click the silence button's arrow, pick 4h, then open the Silenced menu. |
| `home-silence.gif` (+ `.mp4`) | A Home tile → the Alertmanager's alerts by severity → tick two → "Silence 2 Selected…" → confirmation → result above the list. | Home, click the eu-prod tile, tick two warnings, click Silence 2 Selected…, confirm. |
| `search.gif` (+ `.png`, `.mp4`) | ⌘F, typing `api`, then `namespace=prod` turning into a token, results from several channels (eu-prod › payments, us-prod › checkout) with their channel; Return opens one. Still: results with the token. | Live or any channel, ⌘F, type `api `, then `namespace=prod ` (the space finishes the token). |
| `shortcuts.png` | The keyboard shortcuts help over Home: the dimmed window and the panel with Navigation, Alerts, Search and App. | Home, then ⌥? (Option and the key that types `?`), or Help › Keyboard Shortcuts. |
| `notification.gif` (+ `.png`, `.mp4`) | A banner for a new critical alert, hover → Options → Mark as Read / Silence 1h … 1w, then clicking the banner opens the alert. Still: the banner with Options open. | Make sure notifications are on in Settings (allow when macOS asks). Close the window (app stays in the menu bar), then `curl -X POST 'http://127.0.0.1:8790/demo/fire?count=1'`. Capture the top-right screen region. |
| `menu-bar.png` | The bell menu: unread critical count, newest critical alerts, Mark Critical Alerts as Read, Pause Notifications. | After a fire or two, click the bell in the menu bar. Capture a region around the menu. |
| `remind-me.png` | An alert's details with the Remind Me popover open under its button: the presets with the time each means, the date and time picker. The presets depend on the hour (Later Today and This Evening are gone late in the evening). 2880 × 1590, as `update.png`. | `macos/scripts/demo.sh -NSRequiresAquaSystemAppearance YES`, wait 90 s, Home › Longest firing › `CertificateExpiringSoon`. For the second reminder in its history: ⇧⌘R, Tomorrow Morning, then `curl -X POST http://127.0.0.1:8790/demo/remind`. Then ⇧⌘R again (or the Remind Me button) for the popover, which is a window of its own: `screencapture -o -l <its window id>` captures the main window with it. |
| `reminded.png` | An alert whose reminder came due: unread again, "Reminder 22:21" pill in the header, "Reminder set" and "Reminder" in its history. | The demo's `CertificateExpiringSoon` (eu-prod › platform) has a reminder that comes due 90 s in; open it from Home › Longest firing after that. |
| `update.png` | The toolbar's "Update Available" pill with its popover open: version, published, size, What Changed, Skip / Later / Install and Relaunch. In the README's Updates section. 2880 × 1592: the window as high as the Mac mini's screen allows. | `macos/scripts/demo.sh -NSRequiresAquaSystemAppearance YES -simulateUpdate available`: the made-up update is found a second after launch and the popover opens by itself. Nothing is downloaded; Install and Relaunch only plays the progress. The popover is a window of its own: `screencapture -o -l <its window id>` captures the main window with it. |

The coffee-break animation in the README reuses `macos/Icon/coffee-break/*-small.gif`
(`macos/scripts/render-coffee-break.sh`), so it needs no capture.
