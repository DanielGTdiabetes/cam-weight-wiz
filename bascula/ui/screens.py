"""Screens used by the local Tkinter application."""
from __future__ import annotations

import logging
from typing import Optional, Protocol

import tkinter as tk
from tkinter import ttk

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

        self._tare_button = ttk.Button(self, text="TARA", command=self._handle_tare, style="Tara.TButton")
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
    def _handle_tare(self) -> None:
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

        placeholder = ttk.Label(
            self,
            text="(Componentes de escaneo se integran aquí)",
            foreground="#6b7280",
            font=("Segoe UI", 11, "italic"),
        )
        placeholder.pack(anchor="center", pady=(24, 0))

