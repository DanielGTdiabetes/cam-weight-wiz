"""Main Tkinter application wiring screens and services."""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk
from typing import Optional

from bascula.state import AppState
from bascula.ui.screens import HomeScreen, ScaleServiceProtocol, ScanScreen
from bascula.ui.widgets import SupportsBeep, TimerController


class BasculaApp(tk.Tk):
    """Tk application hosting the weighing and food scanning screens."""

    def __init__(
        self,
        scale_service: ScaleServiceProtocol,
        *,
        audio_service: Optional[SupportsBeep] = None,
        app_state: Optional[AppState] = None,
    ) -> None:
        super().__init__()
        self.title("Báscula Inteligente")
        self.geometry("600x480")

        self.state_manager = app_state or AppState()
        self.scale_service = scale_service
        self.timer_controller = TimerController(self, self.state_manager, audio_service)

        self._screens: dict[str, ttk.Frame] = {}
        self._build_ui()
        self.show_home()

    # ------------------------------------------------------------------
    # Public helpers
    # ------------------------------------------------------------------
    def show_home(self) -> None:
        self._show_screen("home")

    def show_scan(self) -> None:
        self._show_screen("scan")

    def update_weight(self, weight: float, *, unit: str = "g", stable: bool = False) -> None:
        """Propagate a new weight measurement to the UI."""

        self.state_manager.set_weight(weight, unit=unit, stable=stable)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _build_ui(self) -> None:
        container = ttk.Frame(self)
        container.pack(fill="both", expand=True)

        nav = ttk.Frame(container)
        nav.pack(fill="x", padx=16, pady=(16, 0))

        ttk.Button(nav, text="Báscula", command=self.show_home).pack(side=tk.LEFT, padx=(0, 8))
        ttk.Button(nav, text="Escáner", command=self.show_scan).pack(side=tk.LEFT)

        content = ttk.Frame(container)
        content.pack(fill="both", expand=True, padx=16, pady=16)
        content.grid_rowconfigure(0, weight=1)
        content.grid_columnconfigure(0, weight=1)

        home = HomeScreen(content, self.state_manager, self.scale_service, self.timer_controller)
        scan = ScanScreen(content, self.state_manager, self.timer_controller)

        self._screens["home"] = home
        self._screens["scan"] = scan

        home.grid(row=0, column=0, sticky="nsew")
        scan.grid(row=0, column=0, sticky="nsew")

    def _show_screen(self, name: str) -> None:
        screen = self._screens.get(name)
        if screen is None:
            raise KeyError(f"Pantalla desconocida: {name}")
        screen.tkraise()


__all__ = ["BasculaApp"]
