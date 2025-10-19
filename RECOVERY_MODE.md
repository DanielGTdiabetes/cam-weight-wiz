# Modo de Recuperación - Báscula Inteligente

## 🚨 Sistema No Arranca Después de la Instalación

Si el sistema se queda en la pantalla de carga del kernel después de ejecutar `install-all.sh`, es probable que alguna configuración de hardware esté causando conflictos.

## Solución Rápida

### Opción 1: Editar desde otra computadora

1. **Apaga la Raspberry Pi**
2. **Saca la tarjeta SD** y conéctala a otra computadora
3. **Monta la partición de boot** (debería aparecer como `bootfs` o `boot`)
4. **Edita el archivo** `/boot/firmware/config.txt` (o `/boot/config.txt` en versiones antiguas)
5. **Comenta las líneas problemáticas** añadiendo `#` al inicio:

```bash
# --- Bascula-Cam: Hardware Configuration ---
# HDMI para pantalla 7" (1024x600)
hdmi_force_hotplug=1
hdmi_group=2
hdmi_mode=87
hdmi_cvt=1024 600 60 3 0 0 0
dtoverlay=vc4-kms-v3d
disable_overscan=1

# Audio I2S (comentar si no tienes hardware I2S conectado)
#dtparam=audio=off
#dtoverlay=i2s-mmap
#dtoverlay=hifiberry-dac

# I2C
dtparam=i2c_arm=on

# UART para ESP32
enable_uart=1
dtoverlay=disable-bt

# Camera Module 3 (comentar si la cámara no está conectada)
#camera_auto_detect=1
#dtoverlay=imx708
# --- Bascula-Cam (end) ---
```

6. **Guarda el archivo** y expulsa la tarjeta SD de forma segura
7. **Vuelve a insertar la SD** en la Raspberry Pi
8. **Enciende** el sistema

### Opción 2: Usar un monitor y teclado

1. **Conecta un monitor HDMI** y **teclado USB** a la Raspberry Pi
2. Si logras ver algo en pantalla, **presiona Ctrl+Alt+F1** para cambiar a terminal
3. **Inicia sesión** con tu usuario (por defecto: `pi`)
4. **Edita el config.txt**:
   ```bash
   sudo nano /boot/firmware/config.txt
   ```
5. **Comenta las líneas** como se indica arriba
6. **Guarda** (Ctrl+O, Enter) y **sal** (Ctrl+X)
7. **Reinicia**:
   ```bash
   sudo reboot
   ```

## Configuración Mínima Segura

Si quieres una configuración mínima que garantice el arranque, reemplaza la sección `# --- Bascula-Cam` con:

```bash
# --- Bascula-Cam: Configuración Mínima ---
# HDMI básico
hdmi_force_hotplug=1
dtoverlay=vc4-kms-v3d

# UART para ESP32
enable_uart=1
dtoverlay=disable-bt

# I2C
dtparam=i2c_arm=on
# --- Bascula-Cam (end) ---
```

Esta configuración solo habilita lo esencial (HDMI, UART, I2C) sin hardware específico.

## Habilitar Hardware Paso a Paso

Una vez que el sistema arranque con la configuración mínima:

### 1. Habilitar Cámara Module 3

```bash
sudo nano /boot/firmware/config.txt
```

Añadir:
```bash
camera_auto_detect=1
dtoverlay=imx708
```

Reiniciar y probar:
```bash
sudo reboot
libcamera-hello --list-cameras
```

> ℹ️ Si utilizas el instalador (`scripts/install-all.sh`), el overlay del **imx708** se aplicará automáticamente cuando se espere un Camera Module 3. Para omitirlo porque usas otro sensor, exporta `CAMERA_SKIP_IMX708_OVERLAY=1` o especifica `CAMERA_MODEL=<sensor>` antes de ejecutar el script.

### 2. Habilitar Audio I2S (HifiBerry DAC / MAX98357A)

```bash
sudo nano /boot/firmware/config.txt
```

Añadir:
```bash
dtparam=audio=off
dtoverlay=i2s-mmap
dtoverlay=hifiberry-dac
```

Reiniciar y probar:
```bash
sudo reboot
aplay -l
```

### 3. Configurar HDMI Personalizado (Pantalla 1024x600)

```bash
sudo nano /boot/firmware/config.txt
```

Añadir:
```bash
hdmi_group=2
hdmi_mode=87
hdmi_cvt=1024 600 60 3 0 0 0
```

Reiniciar:
```bash
sudo reboot
```

## Verificar Servicios

Una vez que el sistema arranque correctamente:

```bash
# Ver estado de los servicios
sudo systemctl status bascula-miniweb.service
sudo systemctl status bascula-ui.service
sudo systemctl status ocr-service.service

# Ver logs
journalctl -u bascula-miniweb.service -f
journalctl -u bascula-ui.service -f
```

## Script de Instalación Seguro

Ejecutar el instalador sin configurar hardware específico:

```bash
export SKIP_HARDWARE_CONFIG=1
sudo bash ~/bascula-ui/scripts/install-all.sh
```

Esto instalará todo el software pero no modificará `/boot/firmware/config.txt`.

## Verificar Hardware X735 v3

Si tienes la placa X735 v3 instalada:

```bash
# Verificar que PWM está disponible
ls -la /sys/class/pwm/

# Ver estado de los servicios X735
systemctl status x735-fan.service
systemctl status x735-pwr.service

# Ver logs
journalctl -u x735-fan.service -n 50
journalctl -u x735-pwr.service -n 50
```

Si el ventilador no funciona:
- Asegúrate de tener kernel >= 6.6.22: `uname -r`
- Verifica que existe `/sys/class/pwm/pwmchip2` (Raspberry Pi 5)
- Reinicia los servicios: `sudo systemctl restart x735-fan.service`

## Contacto y Soporte

Si los problemas persisten:
- Revisa los logs del kernel: `dmesg | tail -50`
- Verifica el sistema de archivos: `sudo fsck /dev/mmcblk0p2`
- Considera reinstalar Raspberry Pi OS desde cero
