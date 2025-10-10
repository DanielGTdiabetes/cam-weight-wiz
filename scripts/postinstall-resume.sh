#!/bin/sh
set -eu
systemd-tmpfiles --create /etc/tmpfiles.d/bascula.conf || true
chgrp -R www-data /run/bascula/captures 2>/dev/null || true
chmod 2770 /run/bascula/captures 2>/dev/null || true
systemctl try-restart bascula-miniweb.service bascula-ui.service || true
