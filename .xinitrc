#!/bin/sh
# Minimal X session for Bascula kiosk

xset s off
xset -dpms
xset s noblank

unclutter -idle 0.5 -root &

openbox &

sleep 2

chmod +x /opt/bascula/current/scripts/kiosk-launch.sh
/opt/bascula/current/scripts/kiosk-launch.sh >> /var/log/bascula/app.log 2>&1
