#!/usr/bin/env bash
# ============================================================
# X session startup — launched in background by entrypoint.sh after
# Xvfb is ready. Owns the X session: setroot color, then exec Openbox.
# Openbox exits when X dies, which propagates as a child death up to
# entrypoint's `wait -n` (correct fail-fast behavior).
# ============================================================
set -euo pipefail

# Solid dark-gray root so a missing wallpaper looks intentional, not broken.
# (xsetroot ships with x11-utils, already installed in the image.)
xsetroot -solid "#1f2933" || true

# Hand over PID 1 of the X session to Openbox.
exec openbox-session
