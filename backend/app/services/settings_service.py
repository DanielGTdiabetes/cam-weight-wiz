"""
Servicio de configuración robusto con escritura atómica y sincronización.
"""
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple, Set
from pydantic import BaseModel, Field

try:  # Compatibilidad Pydantic v1/v2
    from pydantic import ConfigDict  # type: ignore
except Exception:  # pragma: no cover - ConfigDict no disponible en Pydantic v1
    ConfigDict = None  # type: ignore


class SettingsSchema(BaseModel):
    """Esquema de configuración completo"""

    if ConfigDict is None:
        class Config:  # type: ignore[too-many-ancestors]
            extra = "allow"

    else:  # pragma: no cover - executed only with Pydantic v2
        model_config = ConfigDict(extra="allow")  # type: ignore[misc]
    
    class NetworkSettings(BaseModel):
        openai_api_key: Optional[str] = None
    
    class DiabetesSettings(BaseModel):
        nightscout_url: Optional[str] = None
        nightscout_token: Optional[str] = None
        diabetes_enabled: bool = False
        correction_factor: float = 30.0
        carb_ratio: float = 10.0
        target_glucose: float = 100.0
        hypo_alarm: float = 70.0
        hyper_alarm: float = 180.0
    
    class UiSettings(BaseModel):
        sound_enabled: bool = False
        flags: Dict[str, bool] = Field(default_factory=dict)
    
    class ScaleSettings(BaseModel):
        calibration_factor: float = 1.0
        decimals: int = 1
        dt_pin: int = 5
        sck_pin: int = 6
        sample_rate_hz: float = 20.0
        filter_window: int = 12
    
    class MetaSettings(BaseModel):
        version: int = 1
        updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    
    network: NetworkSettings = Field(default_factory=NetworkSettings)
    diabetes: DiabetesSettings = Field(default_factory=DiabetesSettings)
    ui: UiSettings = Field(default_factory=UiSettings)
    scale: ScaleSettings = Field(default_factory=ScaleSettings)
    meta: MetaSettings = Field(default_factory=MetaSettings)
    
    # Legacy fields for compatibility
    openai_api_key: Optional[str] = None
    nightscout_url: Optional[str] = None
    nightscout_token: Optional[str] = None
    integrations: Dict[str, Any] = Field(default_factory=dict)
    tts: Dict[str, Any] = Field(default_factory=dict)
    serial_device: str = "/dev/serial0"
    serial_baud: int = 115200
    scale_backend: str = "uart"


class SettingsService:
    """Servicio de configuración thread-safe con escritura atómica"""
    
    def __init__(self, config_path: Path):
        self.config_path = config_path
        self._lock = threading.Lock()
        self._ensure_dir()
        self._migrate_if_needed()
    
    def _ensure_dir(self) -> None:
        """Asegura que el directorio de configuración existe con permisos correctos"""
        config_dir = self.config_path.parent
        config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        
        # Asegurar propiedad pi:pi si estamos corriendo como root
        try:
            import pwd
            pi_uid = pwd.getpwnam("pi").pw_uid
            pi_gid = pwd.getpwnam("pi").pw_gid
            if os.getuid() == 0:  # Running as root
                os.chown(config_dir, pi_uid, pi_gid)
                if self.config_path.exists():
                    os.chown(self.config_path, pi_uid, pi_gid)
        except (KeyError, PermissionError, ImportError):
            pass  # No es crítico
    
    def _migrate_if_needed(self) -> None:
        """Migra configuración antigua al nuevo formato"""
        if not self.config_path.exists():
            return
        
        with self._lock:
            try:
                data = self._load_raw()
                migrated = False
                
                # Migración 1: Mover openai_api_key mal ubicado
                if "diabetes" in data:
                    if isinstance(data["diabetes"], dict):
                        if "openai_api_key" in data["diabetes"]:
                            if "network" not in data:
                                data["network"] = {}
                            if not data["network"].get("openai_api_key"):
                                data["network"]["openai_api_key"] = data["diabetes"]["openai_api_key"]
                            del data["diabetes"]["openai_api_key"]
                            migrated = True
                
                # Migración 2: Normalizar estructura
                if migrated:
                    self._save_atomic(data)
                    
            except Exception:
                pass  # No critical
    
    def _load_raw(self) -> Dict[str, Any]:
        """Carga configuración raw sin validación"""
        if not self.config_path.exists():
            return {}
        
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return {}
    
    def _save_atomic(self, data: Dict[str, Any]) -> None:
        """Guarda configuración de forma atómica"""
        # Actualizar metadata
        if "meta" not in data:
            data["meta"] = {}
        data["meta"]["version"] = data.get("meta", {}).get("version", 0) + 1
        data["meta"]["updated_at"] = datetime.now(timezone.utc).isoformat()
        
        # Escribir a archivo temporal
        tmp_path = self.config_path.with_suffix(".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())

        # Asegurar permisos
        os.chmod(tmp_path, 0o600)

        # Atomic rename
        os.replace(tmp_path, self.config_path)

        # Garantizar permisos/propietario correctos tras el rename
        try:
            if os.getuid() == 0:
                import pwd

                pi_uid = pwd.getpwnam("pi").pw_uid
                pi_gid = pwd.getpwnam("pi").pw_gid
                os.chown(self.config_path, pi_uid, pi_gid)
        except (KeyError, PermissionError, ImportError):
            pass
        finally:
            try:
                os.chmod(self.config_path, 0o600)
            except PermissionError:
                pass
    
    def load(self) -> SettingsSchema:
        """Carga y valida configuración"""
        with self._lock:
            data = self._load_raw()
            try:
                return SettingsSchema(**data)
            except Exception:
                # Fallback a configuración por defecto
                return SettingsSchema()
    
    def save(self, updates: Dict[str, Any]) -> Tuple[SettingsSchema, Set[str]]:
        """
        Guarda cambios y devuelve (settings actualizados, campos cambiados)
        """
        with self._lock:
            current_data = self._load_raw()
            changed_fields: Set[str] = set()

            # Aplicar updates y detectar cambios
            for key, value in updates.items():
                if key == "network":
                    if "network" not in current_data:
                        current_data["network"] = {}
                    if current_data["network"] != value:
                        changed_fields.add("network")
                    current_data["network"] = value
                
                elif key == "diabetes":
                    if "diabetes" not in current_data:
                        current_data["diabetes"] = {}
                    if current_data["diabetes"] != value:
                        changed_fields.add("diabetes")
                    current_data["diabetes"] = value
                
                elif key == "ui":
                    if "ui" not in current_data:
                        current_data["ui"] = {}
                    if current_data["ui"] != value:
                        changed_fields.add("ui")
                    current_data["ui"] = value
                
                elif key == "scale":
                    if "scale" not in current_data:
                        current_data["scale"] = {}
                    if current_data["scale"] != value:
                        changed_fields.add("scale")
                    current_data["scale"] = value
                
                else:
                    if current_data.get(key) != value:
                        changed_fields.add(key)
                    current_data[key] = value

            if not changed_fields:
                # Nada cambió; devolver estado actual validado sin tocar disco
                return SettingsSchema(**current_data), changed_fields

            # Guardar atómicamente
            self._save_atomic(current_data)

            # Validar con el nuevo estado (current_data ya contiene meta actualizada)
            settings = SettingsSchema(**current_data)
            return settings, changed_fields
    
    def get_for_client(self, include_secrets: bool = False) -> Dict[str, Any]:
        """
        Obtiene configuración para el cliente con placeholders para secretos
        """
        settings = self.load()
        data = settings.dict()
        
        if not include_secrets:
            # Ocultar secretos con placeholders
            if data.get("network", {}).get("openai_api_key"):
                data["network"]["openai_api_key"] = "__stored__"
            if data.get("diabetes", {}).get("nightscout_token"):
                data["diabetes"]["nightscout_token"] = "__stored__"
            if data.get("diabetes", {}).get("nightscout_url"):
                data["diabetes"]["nightscout_url"] = "__stored__"
            if data.get("openai_api_key"):
                data["openai_api_key"] = "__stored__"
            if data.get("nightscout_token"):
                data["nightscout_token"] = "__stored__"
            if data.get("integrations", {}).get("openai_api_key"):
                data["integrations"]["openai_api_key"] = "__stored__"
            if data.get("integrations", {}).get("nightscout_token"):
                data["integrations"]["nightscout_token"] = "__stored__"
        
        return data


# Singleton instance
_service_instance: Optional[SettingsService] = None
_service_lock = threading.Lock()


def get_settings_service(config_path: Optional[Path] = None) -> SettingsService:
    """Obtiene o crea instancia del servicio"""
    global _service_instance
    
    with _service_lock:
        if _service_instance is None:
            if config_path is None:
                config_path = Path.home() / ".bascula" / "config.json"
            _service_instance = SettingsService(config_path)
        
        return _service_instance
