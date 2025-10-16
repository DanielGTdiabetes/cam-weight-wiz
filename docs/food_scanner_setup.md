# Dependencias para el escáner de alimentos

Para habilitar todas las funciones del escáner (códigos de barras, OCR y TTS opcional) instala los siguientes paquetes en la Raspberry Pi.

## Paquetes del sistema (APT)

```bash
sudo apt-get update
sudo apt-get install -y zbar-tools libzbar0 tesseract-ocr tesseract-ocr-spa imagemagick
```

## Paquetes Python (pip en el entorno virtual del backend)

```bash
source /opt/bascula/current/.venv/bin/activate
pip install --upgrade fastapi pydantic uvicorn requests Pillow pyzbar pytesseract
```

> Nota: los requisitos principales ya están listados en `requirements.txt`, pero este recordatorio permite reinstalar rápidamente las dependencias necesarias tras una restauración del sistema.
