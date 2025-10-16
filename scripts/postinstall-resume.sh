#!/bin/sh
set -eu
systemd-tmpfiles --create || true
chgrp -R www-data /run/bascula/captures 2>/dev/null && chmod 2770 /run/bascula/captures 2>/dev/null || true
systemctl try-restart bascula-miniweb bascula-ui || true
