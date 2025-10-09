"""Reusable widgets for the local Tkinter application."""
from __future__ import annotations

import logging
from typing import Callable, Optional, Protocol

import tkinter as tk
from tkinter import ttk

from bascula.state import AppState, TimerState

LOGGER = logging.getLogger(__name__)


class SupportsBeep(Protocol):
    """Protocol for audio services that expose a ``beep`` method."""

    def beep(self) -> None:  # pragma: no cover - simple protocol definition
        ...


def _format_seconds(value: int) -> str:
    minutes, seconds = divmod(max(0, int(value)), 60)
    return f"{minutes:02d}:{seconds:02d}"


class TimerController:
    """Centralized controller that updates the shared timer state."""

    def __init__(
        self,
        tk_root: tk.Misc,
        state: AppState,
        audio_service: Optional[SupportsBeep] = None,
    ) -> None:
        if isinstance(tk_root, tk.Tk):
            self._root = tk_root
        else:
            default_root = getattr(tk, "_default_root", None)
            if isinstance(default_root, tk.Tk):
                self._root = default_root
            else:
                try:
                    self._root = tk_root.winfo_toplevel()
                except Exception:
                    self._root = tk_root
        self._state = state
        self._audio_service = audio_service
        self._timer_job: Optional[str] = None
        self._last_notified_completion: Optional[float] = None

    def start(self, seconds: int) -> None:
        duration = max(0, int(seconds))
        self.cancel()
        if duration <= 0:
            self._state.stop_timer()
            return
        self._state.start_timer(duration)
        self._last_notified_completion = None
        LOGGER.debug("TimerController.start: iniciando cuenta atrás de %s segundos", duration)
        self._schedule_tick()

    def cancel(self) -> None:
        if self._timer_job is not None:
            try:
                self._root.after_cancel(self._timer_job)
            except Exception:  # pragma: no cover - Tk may raise if already cancelled
                pass
            self._timer_job = None
        self._state.stop_timer()
        self._last_notified_completion = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _tick(self) -> None:
        remaining = self._state.decrement_timer()
        if remaining > 0:
            LOGGER.debug("TimerController._tick: quedan %s segundos", remaining)
            self._schedule_tick()
            return

        self._timer_job = None
        timer_state = self._state.get_timer_state()
        self._last_notified_completion = timer_state.completed_at
        LOGGER.debug("TimerController._tick: temporizador completado")
        self._play_beep()

    def notify_completed(self, completed_at: Optional[float]) -> None:
        """Trigger completion feedback when a new completion timestamp arrives."""

        if not completed_at:
            return
        if self._last_notified_completion == completed_at:
            return
        self._last_notified_completion = completed_at
        LOGGER.debug("TimerController.notify_completed: beep solicitado por UI")
        self._play_beep()

    def _schedule_tick(self) -> None:
        try:
            self._timer_job = self._root.after(1000, self._tick)
        except Exception as exc:
            LOGGER.warning("TimerController._schedule_tick: after() falló (%s), reintentando", exc)
            try:
                self._timer_job = self._root.after(1000, self._tick)
            except Exception as retry_exc:
                LOGGER.error(
                    "TimerController._schedule_tick: reintento de after() falló (%s)", retry_exc
                )
                self._timer_job = None

    def _play_beep(self) -> None:
        played = False
        if self._audio_service is not None:
            try:
                self._audio_service.beep()
                played = True
            except Exception as exc:  # pragma: no cover - depends on hardware
                LOGGER.warning("AudioService.beep() failed: %s", exc)

        if not played:
            try:
                self._root.bell()
            except Exception:
                LOGGER.debug("Fallback bell() not available on this platform")


class TimerDialog(tk.Toplevel):
    """Dialog to configure and start the shared timer."""

    def __init__(
        self,
        parent: tk.Misc,
        on_start: Callable[[int], None],
        on_cancel: Callable[[], None],
    ) -> None:
        super().__init__(parent)
        self.title("Temporizador")
        self.transient(parent)
        self.resizable(False, False)
        self._on_start = on_start
        self._on_cancel = on_cancel
        self._minutes_var = tk.StringVar(value="00")
        self._seconds_var = tk.StringVar(value="00")
        self._error_var = tk.StringVar()

        self.bind("<Escape>", lambda _event: self._handle_cancel())
        self.protocol("WM_DELETE_WINDOW", self._handle_cancel)

        self._build()

    def _build(self) -> None:
        container = ttk.Frame(self, padding=16)
        container.grid(column=0, row=0, sticky="nsew")

        title = ttk.Label(container, text="Temporizador de cocina", font=("Segoe UI", 14, "bold"))
        title.grid(column=0, row=0, columnspan=4, sticky="w")

        ttk.Label(container, text="Minutos").grid(column=0, row=1, sticky="w", pady=(12, 4))
        minutes_spin = tk.Spinbox(
            container,
            from_=0,
            to=59,
            textvariable=self._minutes_var,
            width=5,
            font=("Segoe UI", 12),
            justify="center",
            wrap=True,
        )
        minutes_spin.grid(column=0, row=2, sticky="w")

        ttk.Label(container, text="Segundos").grid(column=1, row=1, sticky="w", padx=(12, 0), pady=(12, 4))
        seconds_spin = tk.Spinbox(
            container,
            from_=0,
            to=59,
            textvariable=self._seconds_var,
            width=5,
            font=("Segoe UI", 12),
            justify="center",
            wrap=True,
        )
        seconds_spin.grid(column=1, row=2, sticky="w", padx=(12, 0))

        presets_frame = ttk.Frame(container)
        presets_frame.grid(column=0, row=3, columnspan=4, sticky="w", pady=(16, 8))
        ttk.Label(presets_frame, text="Rápidos:").grid(column=0, row=0, sticky="w", padx=(0, 8))
        for index, seconds in enumerate((60, 120, 300), start=1):
            button = ttk.Button(
                presets_frame,
                text=_format_seconds(seconds),
                command=lambda value=seconds: self._apply_preset(value),
            )
            button.grid(column=index, row=0, padx=(0, 8))

        actions = ttk.Frame(container)
        actions.grid(column=0, row=4, columnspan=4, sticky="ew", pady=(8, 0))
        actions.columnconfigure(0, weight=1)
        actions.columnconfigure(1, weight=1)

        start_button = ttk.Button(actions, text="Iniciar", command=self._handle_start)
        start_button.grid(column=0, row=0, sticky="ew", padx=(0, 8))

        cancel_button = ttk.Button(actions, text="Cancelar", command=self._handle_cancel)
        cancel_button.grid(column=1, row=0, sticky="ew")

        error_label = ttk.Label(container, textvariable=self._error_var, foreground="#dc2626")
        error_label.grid(column=0, row=5, columnspan=4, sticky="w", pady=(12, 0))

    # ------------------------------------------------------------------
    # Event handlers
    # ------------------------------------------------------------------
    def _apply_preset(self, seconds: int) -> None:
        minutes, remainder = divmod(seconds, 60)
        self._minutes_var.set(f"{minutes:02d}")
        self._seconds_var.set(f"{remainder:02d}")
        self._error_var.set("")

    def _handle_start(self) -> None:
        try:
            minutes = int(self._minutes_var.get() or "0")
            seconds = int(self._seconds_var.get() or "0")
        except ValueError:
            self._error_var.set("Introduce números válidos")
            return

        total_seconds = minutes * 60 + seconds
        if total_seconds <= 0:
            self._error_var.set("Configura un tiempo mayor a cero")
            return

        self._error_var.set("")
        self._on_start(total_seconds)
        self.destroy()

    def _handle_cancel(self) -> None:
        self._on_cancel()
        self.destroy()


class TimerWidget(ttk.Frame):
    """Widget that exposes a timer icon, countdown and cancel button."""

    def __init__(
        self,
        parent: tk.Misc,
        state: AppState,
        controller: TimerController,
        *,
        icon_text: str = "⏱",
    ) -> None:
        super().__init__(parent)
        self._state = state
        self._controller = controller
        self._icon_default_text = icon_text
        self._blink_job: Optional[str] = None
        self._blink_index = 0
        self._last_completion: Optional[float] = None
        self._message_job: Optional[str] = None
        self._subscription = self._state.subscribe_timer(self._on_timer_state)

        self._countdown_label = ttk.Label(self, font=("Segoe UI", 18, "bold"))
        self._countdown_label.pack_forget()

        self._icon_button = ttk.Button(
            self,
            text=self._icon_default_text,
            command=self._open_dialog,
            style="Timer.Icon.TButton",
            width=4,
        )
        self._icon_button.pack(side=tk.TOP)

        self._cancel_button = ttk.Button(self, text="Cancelar", command=self._handle_cancel)
        self._cancel_button.pack_forget()

        self._message_label = ttk.Label(self, foreground="#dc2626")
        self._message_label.pack_forget()

        self.bind("<Destroy>", self._on_destroy)
        self._setup_styles()

    # ------------------------------------------------------------------
    # UI helpers
    # ------------------------------------------------------------------
    def _setup_styles(self) -> None:
        style = ttk.Style(self)
        style.configure("Timer.Icon.TButton", font=("Segoe UI", 16))
        style.configure("Timer.Active.TButton", font=("Segoe UI", 16), foreground="#d97706")

    def _open_dialog(self) -> None:
        TimerDialog(self, self._controller.start, self._controller.cancel)

    def _handle_cancel(self) -> None:
        self._controller.cancel()

    def _start_blink(self) -> None:
        self._stop_blink()
        self._blink_index = 0
        self._blink_job = self.after(500, self._toggle_blink)

    def _toggle_blink(self) -> None:
        self._blink_index = 1 - self._blink_index
        text = self._icon_default_text if self._blink_index == 0 else f"{self._icon_default_text}•"
        self._icon_button.configure(text=text)
        self._blink_job = self.after(500, self._toggle_blink)

    def _stop_blink(self) -> None:
        if self._blink_job is not None:
            try:
                self.after_cancel(self._blink_job)
            except Exception:
                pass
            self._blink_job = None
        self._icon_button.configure(text=self._icon_default_text)

    def _show_finished_message(self) -> None:
        self._hide_finished_message()
        self._message_label.configure(text="Tiempo finalizado")
        self._message_label.pack(side=tk.TOP, pady=(6, 0))
        self._message_job = self.after(4000, self._hide_finished_message)

    def _hide_finished_message(self) -> None:
        if self._message_job is not None:
            try:
                self.after_cancel(self._message_job)
            except Exception:
                pass
            self._message_job = None
        if self._message_label.winfo_manager():
            self._message_label.pack_forget()

    # ------------------------------------------------------------------
    # State handling
    # ------------------------------------------------------------------
    def _on_timer_state(self, timer_state: TimerState) -> None:
        self.after(0, lambda: self._render_state(timer_state))

    def _render_state(self, timer_state: TimerState) -> None:
        if timer_state.active:
            self._icon_button.state(["disabled"])
            self._icon_button.configure(style="Timer.Active.TButton")
            if not self._countdown_label.winfo_manager():
                self._countdown_label.pack(side=tk.TOP, pady=(0, 6))
            self._countdown_label.configure(text=_format_seconds(timer_state.remaining_seconds))
            if not self._cancel_button.winfo_manager():
                self._cancel_button.pack(side=tk.TOP, pady=(0, 6))
            self._start_blink()
            self._hide_finished_message()
        else:
            self._icon_button.state(["!disabled"])
            self._icon_button.configure(style="Timer.Icon.TButton")
            if self._countdown_label.winfo_manager():
                self._countdown_label.pack_forget()
            if self._cancel_button.winfo_manager():
                self._cancel_button.pack_forget()
            self._stop_blink()

            if timer_state.remaining_seconds <= 0:
                self._icon_button.configure(text=self._icon_default_text)

        if timer_state.completed_at and timer_state.completed_at != self._last_completion:
            self._last_completion = timer_state.completed_at
            self._controller.notify_completed(timer_state.completed_at)
            self._show_finished_message()
        elif not timer_state.completed_at:
            self._last_completion = None

    def _on_destroy(self, _event: tk.Event) -> None:
        if self._subscription is not None:
            try:
                self._subscription()
            except Exception:
                pass
            self._subscription = None
        self._stop_blink()
        self._hide_finished_message()

