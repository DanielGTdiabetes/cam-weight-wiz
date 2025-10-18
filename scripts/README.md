# Scripts de instalación

## Parámetro `WIFI_COUNTRY`

El instalador principal (`install-all.sh`) admite la variable de entorno `WIFI_COUNTRY` para fijar el país Wi-Fi de la Raspberry Pi.

- Predeterminado: `ES` (España).
- Sobrescribe el valor al invocar el script:

  ```bash
  sudo WIFI_COUNTRY=CL ./scripts/install-all.sh
  ```

Consulta la guía detallada en [`../docs/INSTALL.md`](../docs/INSTALL.md) para conocer los pasos automáticos, headless y manuales, además de las comprobaciones y la resolución de problemas.
