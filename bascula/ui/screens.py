"""Screens used by the local Tkinter application."""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Optional, Protocol

import tkinter as tk
from tkinter import ttk

import requests
from PIL import Image, ImageTk

from bascula.state import AppState, WeightState
from bascula.ui.widgets import TimerController, TimerWidget

LOGGER = logging.getLogger(__name__)


class ScaleServiceProtocol(Protocol):
    """Protocol representing the subset of the scale service we rely on."""

    def tare(self) -> object:  # pragma: no cover - protocol definition only
        ...


class HomeScreen(ttk.Frame):
    """Main weighing screen with TARA button and timer shortcut."""

    def __init__(
        self,
        parent: tk.Misc,
        state: AppState,
        scale_service: ScaleServiceProtocol,
        timer_controller: TimerController,
    ) -> None:
        super().__init__(parent, padding=24)
        self._state = state
        self._scale_service = scale_service
        self._timer_controller = timer_controller
        self._tare_in_progress = False
        self._tara_job: Optional[str] = None
        self._weight_subscription = self._state.subscribe_weight(self._on_weight_update)
        self._tare_subscription = self._state.subscribe_tare(self._on_tare_event)

        self._build()
        self.bind("<Destroy>", self._on_destroy)

    def _build(self) -> None:
        title = ttk.Label(self, text="Peso actual", font=("Segoe UI", 22, "bold"))
        title.pack(anchor="w")

        self._weight_label = ttk.Label(self, text="0.0 g", font=("Segoe UI", 64, "bold"))
        self._weight_label.pack(fill="x", pady=(12, 24))

        self._tara_message = ttk.Label(self, foreground="#2563eb", font=("Segoe UI", 12))
        self._tara_message.pack_forget()

        self._tare_button = ttk.Button(self, text="TARA", command=self._on_tare, style="Tara.TButton")
        self._tare_button.pack(pady=(0, 24))

        timer_frame = ttk.LabelFrame(self, text="Temporizador")
        timer_frame.pack(fill="x")
        self._timer_widget = TimerWidget(timer_frame, self._state, self._timer_controller)
        self._timer_widget.pack(pady=(8, 0))

        style = ttk.Style(self)
        style.configure("Tara.TButton", font=("Segoe UI", 20, "bold"), padding=12)

    # ------------------------------------------------------------------
    # Event handlers
    # ------------------------------------------------------------------
    def _on_tare(self) -> None:
        if self._tare_in_progress:
            return

        self._tare_in_progress = True
        try:
            self._scale_service.tare()
        except Exception as exc:  # pragma: no cover - depends on hardware/service
            LOGGER.error("No se pudo aplicar la tara: %s", exc)
            self._show_tara_message("Error al aplicar tara", foreground="#dc2626")
        else:
            self._state.set_weight(0.0, stable=True)
            self._state.record_tare_event()
            self._show_tara_message("Tara aplicada")
        finally:
            self._tare_in_progress = False

    def _on_weight_update(self, weight_state: WeightState) -> None:
        self.after(0, lambda: self._render_weight(weight_state))

    def _on_tare_event(self, _timestamp: float) -> None:
        self.after(0, lambda: self._show_tara_message("Tara aplicada"))

    def _render_weight(self, weight_state: WeightState) -> None:
        unit = weight_state.unit or "g"
        weight = weight_state.weight
        text = f"{weight:0.1f} {unit}" if isinstance(weight, (int, float)) else f"{weight} {unit}"
        self._weight_label.configure(text=text)
        if weight_state.stable:
            self._weight_label.configure(foreground="#16a34a")
        else:
            self._weight_label.configure(foreground="")

    def _show_tara_message(self, text: str, *, foreground: Optional[str] = None) -> None:
        if self._tara_job is not None:
            try:
                self.after_cancel(self._tara_job)
            except Exception:
                pass
            self._tara_job = None

        if foreground:
            self._tara_message.configure(foreground=foreground)
        else:
            self._tara_message.configure(foreground="#2563eb")

        self._tara_message.configure(text=text)
        if not self._tara_message.winfo_manager():
            self._tara_message.pack(anchor="w", pady=(0, 16))
        self._tara_job = self.after(3000, self._hide_tara_message)

    def _hide_tara_message(self) -> None:
        self._tara_job = None
        if self._tara_message.winfo_manager():
            self._tara_message.pack_forget()

    def _on_destroy(self, _event: tk.Event) -> None:
        if self._weight_subscription is not None:
            try:
                self._weight_subscription()
            except Exception:
                pass
            self._weight_subscription = None
        if self._tare_subscription is not None:
            try:
                self._tare_subscription()
            except Exception:
                pass
            self._tare_subscription = None
        if self._tara_job is not None:
            try:
                self.after_cancel(self._tara_job)
            except Exception:
                pass
            self._tara_job = None


class ScanScreen(ttk.Frame):
    """Food scanning screen that reuses the shared timer widget."""

    def __init__(
        self,
        parent: tk.Misc,
        state: AppState,
        timer_controller: TimerController,
    ) -> None:
        super().__init__(parent, padding=24)
        self._state = state
        self._timer_controller = timer_controller
        self._preview_photo: Optional[ImageTk.PhotoImage] = None
        self._current_capture: Optional[str] = None
        self._capture_in_progress = False

        header = ttk.Label(self, text="Escáner de alimentos", font=("Segoe UI", 22, "bold"))
        header.pack(anchor="w")

        description = ttk.Label(
            self,
            text=(
                "Usa el temporizador para controlar el tiempo de cocción mientras escaneas"
                " tus alimentos."
            ),
            wraplength=420,
            justify="left",
        )
        description.pack(anchor="w", pady=(8, 16))

        timer_frame = ttk.LabelFrame(self, text="Temporizador")
        timer_frame.pack(fill="x")
        self._timer_widget = TimerWidget(timer_frame, self._state, self._timer_controller)
        self._timer_widget.pack(pady=(8, 0))

        capture_frame = ttk.Frame(self)
        capture_frame.pack(fill="x", pady=(24, 12))

        self._capture_button = ttk.Button(
            capture_frame,
            text="Activar cámara",
            command=self._handle_capture,
            width=18,
        )
        self._capture_button.pack(side="left")

        self._status_label = ttk.Label(
            capture_frame,
            text="Pulsa \"Activar cámara\" para capturar",
            foreground="#2563eb",
            font=("Segoe UI", 10),
        )
        self._status_label.pack(side="left", padx=(12, 0))

        preview_frame = ttk.Frame(self, borderwidth=1, relief="solid", padding=8)
        preview_frame.pack(fill="both", expand=True)

        self._image_label = ttk.Label(
            preview_frame,
            text="Cámara no disponible. Revisa conexión o permisos.",
            justify="center",
            anchor="center",
            font=("Segoe UI", 11),
            foreground="#6b7280",
            wraplength=480,
        )
        self._image_label.pack(fill="both", expand=True)

        self._image_caption = ttk.Label(
            self,
            text="",
            font=("Segoe UI", 9, "italic"),
            foreground="#6b7280",
        )
        self._image_caption.pack(anchor="w", pady=(6, 0))

    def _set_status(self, message: str, *, error: bool = False) -> None:
        colour = "#dc2626" if error else "#2563eb"
        self._status_label.configure(text=message, foreground=colour)

    def _handle_capture(self) -> None:
        if self._capture_in_progress:
            return

        self._capture_in_progress = True
        self._capture_button.state(["disabled"])
        self._set_status("Capturando imagen…")

        def worker() -> None:
            try:
                response = requests.post(
                    "http://localhost:8080/api/camera/capture-to-file",
                    timeout=10,
                )
                response.raise_for_status()
            except requests.RequestException as exc:  # pragma: no cover - network/hardware path
                LOGGER.exception("Error al contactar la API de cámara: %s", exc)
                self.after(
                    0,
                    lambda: self._on_capture_failure(
                        "Cámara no disponible. Revisa conexión o permisos."
                    ),
                )
                return

            try:
                data = response.json()
            except ValueError as exc:  # pragma: no cover - respuesta inválida
                LOGGER.exception("Respuesta JSON inválida de la API de cámara: %s", exc)
                self.after(0, lambda: self._on_capture_failure("Respuesta inválida de la cámara"))
                return

            if not isinstance(data, dict) or not data.get("ok"):
                LOGGER.warning("La API de cámara devolvió error: %s", data)
                self.after(0, lambda: self._on_capture_failure("Error al capturar imagen"))
                return

            default_path = "/tmp/camera-capture.jpg"
            path_value = data.get("path")
            file_path = path_value if isinstance(path_value, str) and path_value else default_path
            display_url = file_path

            size_value = data.get("size")
            try:
                size = int(size_value)
            except (TypeError, ValueError):
                size = 0

            timestamp = int(time.time() * 1000)
            self.after(0, lambda: self._on_capture_success(file_path, display_url, size, timestamp))

        threading.Thread(target=worker, daemon=True).start()

    def _on_capture_success(self, path: str, display_url: str, size: int, timestamp: int) -> None:
        self._capture_in_progress = False
        self._capture_button.state(["!disabled"])
        status_text = "Imagen actualizada" if size <= 0 else f"Imagen actualizada ({size} bytes)"
        self._set_status(status_text, error=False)
        display_path = f"{display_url}?ts={timestamp}"
        self._current_capture = display_path
        self._load_preview(Path(path))

    def _on_capture_failure(self, message: str) -> None:
        self._capture_in_progress = False
        self._capture_button.state(["!disabled"])
        self._set_status(message, error=True)
        if self._preview_photo is None:
            self._image_label.configure(
                text="Cámara no disponible. Revisa conexión o permisos.",
                image="",
            )
            self._image_caption.configure(text="")

    def _load_preview(self, path: Path) -> None:
        try:
            with Image.open(path) as img:
                image = img.copy()
        except Exception as exc:  # pragma: no cover - depends on filesystem
            LOGGER.exception("No se pudo cargar la imagen capturada: %s", exc)
            self._preview_photo = None
            self._image_label.configure(
                text="No se pudo cargar la imagen capturada.",
                image="",
                foreground="#dc2626",
            )
            return

        image.thumbnail((640, 360))
        photo = ImageTk.PhotoImage(image)
        self._preview_photo = photo
        self._image_label.configure(image=photo, text="", foreground="#111827")
        if self._current_capture:
            self._image_caption.configure(text=f"Vista previa: {self._current_capture}")
        else:
            self._image_caption.configure(text="")

        # Asegura que la imagen se refresque incluso si Tkinter cachea recursos.
        self._image_label.after(0, lambda: self._image_label.configure(image=photo))

