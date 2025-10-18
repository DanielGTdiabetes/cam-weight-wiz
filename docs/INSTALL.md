# Guía de instalación

## Configuración del país Wi-Fi

Para que la Raspberry Pi cumpla con las normativas locales (regulatory domain) y active correctamente los canales permitidos, el instalador ajusta el **país Wi-Fi**. Esto es necesario tanto si instalas con interfaz como de forma **headless**.

### Opción A: Automática (recomendada)

El script `install-all.sh` establece el país Wi-Fi de forma no interactiva.

- Por defecto usa `ES` (España).
- Puedes definir otro país al ejecutar el instalador:

```bash
cd ~/cam-weight-wiz/scripts
sudo WIFI_COUNTRY=AR ./install-all.sh
```

El instalador:

- Inserta `country=XX` al inicio de `/etc/wpa_supplicant/wpa_supplicant.conf` si no existe.
- Aplica el dominio regulatorio con `iw reg set XX` y `raspi-config nonint do_wifi_country XX`.
- No detiene la instalación si algo falla; lo registrará como `[install][warn]`.

### Opción B: Headless (antes del primer arranque)

Si preparas la tarjeta SD en otro equipo:

1. Monta la partición boot de la imagen de Raspberry Pi OS.
2. Crea un archivo `wpa_supplicant.conf` en la partición boot con al menos:

   ```conf
   country=ES
   update_config=1
   ctrl_interface=/var/run/wpa_supplicant
   ```

3. (Opcional) Crea un archivo vacío llamado `ssh` para habilitar SSH en el primer arranque.
4. Inserta la tarjeta y arranca la Raspberry Pi.

El instalador respetará `country=XX` si ya existe, sin duplicarlo.

### Opción C: Manual (si lo prefieres)

Puedes establecer el país manualmente:

```bash
sudo raspi-config nonint do_wifi_country US
sudo sed -i '1{/^country=/d;}; 1i country=US' /etc/wpa_supplicant/wpa_supplicant.conf
sudo rfkill unblock wifi || true
sudo iw reg set US || true
```

### Comprobación rápida

```bash
grep -E '^country=' /etc/wpa_supplicant/wpa_supplicant.conf || echo "Sin country"
iw reg get | head -n 5
```

Si ves tu código de país (p. ej. `ES` o `US`), la configuración es correcta.

### Solución de problemas

**El Wi-Fi no aparece o no conecta tras instalar**

- Reinicia: `sudo reboot` (necesario en algunos casos tras cambiar el dominio).
- Confirma `country=XX` en `/etc/wpa_supplicant/wpa_supplicant.conf`.
- Ejecuta: `sudo rfkill unblock wifi` y `sudo iw reg set XX`.
- Verifica logs: `journalctl -u wpa_supplicant --no-pager -b` y `dmesg | grep -i cfg80211`.

**El instalador mostró `[install][warn] País Wi-Fi no definido`**

- Es informativo: el script añadió `country=ES` (o el que pasaste por `WIFI_COUNTRY`).
- Repite la comprobación rápida y, si es necesario, reinicia.

**Nota legal:** usar el código de país correcto es obligatorio para cumplir con la normativa radioeléctrica local y habilitar únicamente los canales/potencias permitidos.
