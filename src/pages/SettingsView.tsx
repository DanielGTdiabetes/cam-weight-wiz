import { useState, useEffect } from "react";
import { Settings, Scale, Wifi, Heart, Download, Save, Upload, Trash2, Volume2, CheckCircle2, ClipboardPaste } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KeyboardDialog } from "@/components/KeyboardDialog";
import { CalibrationWizard } from "@/components/CalibrationWizard";
import { storage } from "@/services/storage";
import { useToast } from "@/hooks/use-toast";
import { useScaleWebSocket } from "@/hooks/useScaleWebSocket";
import { cn } from "@/lib/utils";
import { api, setApiBaseUrl } from "@/services/api";
import { isLocalClient } from "@/lib/network";

export const SettingsView = () => {
  const { toast } = useToast();
  const { weight } = useScaleWebSocket();
  const localClient = isLocalClient();
  const [showCalibrationWizard, setShowCalibrationWizard] = useState(false);
  
  // Load settings on mount
  useEffect(() => {
    const settings = storage.getSettings();
    setVoiceEnabled(settings.isVoiceActive);
    setDiabetesMode(settings.diabetesMode);
    setCalibrationFactor(settings.calibrationFactor.toString());
    setDecimals(settings.decimals?.toString() || "1");
    setApiUrl(settings.apiUrl);
    setWsUrl(settings.wsUrl);
    setChatGptKey(settings.chatGptKey);
    setNightscoutUrl(settings.nightscoutUrl);
    setNightscoutToken(settings.nightscoutToken);
    setCorrectionFactor(settings.correctionFactor.toString());
    setCarbRatio(settings.carbRatio.toString());
    setTargetGlucose(settings.targetGlucose.toString());
    setHypoAlarm(settings.hypoAlarm.toString());
    setHyperAlarm(settings.hyperAlarm.toString());

    // Fetch network status (IP and SSID)
    const fetchNetworkStatus = async () => {
      try {
        const response = await fetch('/api/miniweb/status');
        if (response.ok) {
          const status = await response.json();
          setNetworkIP(status.ip || status.ip_address || "—");
          setNetworkSSID(status.ssid || "—");
          setNetworkIP2(status.ip || status.ip_address || "—");
        }
      } catch (err) {
        console.error("Failed to get network status", err);
        setNetworkSSID("—");
        setNetworkIP2("—");
      }
    };

    fetchNetworkStatus();

    // Refresh network status every 10 seconds
    const interval = setInterval(fetchNetworkStatus, 10000);
    return () => clearInterval(interval);
  }, []);
  
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [diabetesMode, setDiabetesMode] = useState(false);
  const [bolusAssistant, setBolusAssistant] = useState(false);
  
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [keyboardConfig, setKeyboardConfig] = useState<{
    title: string;
    type: "numeric" | "text" | "password" | "url" | "apikey";
    showDecimal?: boolean;
    field: string;
    min?: number;
    max?: number;
    allowEmpty?: boolean;
  }>({ title: "", type: "text", field: "" });

  const [calibrationFactor, setCalibrationFactor] = useState("420.5");
  const [decimals, setDecimals] = useState("1");
  const [apiUrl, setApiUrl] = useState("http://127.0.0.1:8080");
  const [wsUrl, setWsUrl] = useState("ws://127.0.0.1:8080");
  const [chatGptKey, setChatGptKey] = useState("");
  const [nightscoutUrl, setNightscoutUrl] = useState("");
  const [nightscoutToken, setNightscoutToken] = useState("");
  const [correctionFactor, setCorrectionFactor] = useState("30");
  const [carbRatio, setCarbRatio] = useState("10");
  const [targetGlucose, setTargetGlucose] = useState("100");
  const [hypoAlarm, setHypoAlarm] = useState("70");
  const [hyperAlarm, setHyperAlarm] = useState("180");
  const [networkIP, setNetworkIP] = useState<string>("");
  
  const [tempValue, setTempValue] = useState("");
  const [isTestingAudio, setIsTestingAudio] = useState(false);
  const [isTestingChatGPT, setIsTestingChatGPT] = useState(false);
  const [isTestingNightscout, setIsTestingNightscout] = useState(false);
  const [availableUpdates, setAvailableUpdates] = useState<{ available: boolean; version?: string } | null>(null);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [networkSSID, setNetworkSSID] = useState<string>("—");
  const [networkIP2, setNetworkIP2] = useState<string>("—");
  const [internalKeyboardEnabled, setInternalKeyboardEnabled] = useState(localClient);

  // Save settings when they change
  useEffect(() => {
    storage.saveSettings({ isVoiceActive: voiceEnabled });
  }, [voiceEnabled]);

  useEffect(() => {
    storage.saveSettings({ diabetesMode });
  }, [diabetesMode]);

  const openKeyboard = (
    title: string,
    type: "numeric" | "text" | "password" | "url" | "apikey",
    field: string,
    showDecimal = false,
    min?: number,
    max?: number,
    allowEmpty = false
  ) => {
    setKeyboardConfig({ title, type, field, showDecimal, min, max, allowEmpty });
    const currentValue = getCurrentValue(field);
    setTempValue(currentValue);
    setKeyboardOpen(true);
  };

  const getCurrentValue = (field: string): string => {
    const values: Record<string, string> = {
      calibrationFactor,
      decimals,
      apiUrl,
      wsUrl,
      chatGptKey,
      nightscoutUrl,
      nightscoutToken,
      correctionFactor,
      carbRatio,
      targetGlucose,
      hypoAlarm,
      hyperAlarm,
    };
    return values[field] || "";
  };

  const handleKeyboardConfirm = () => {
    const setters: Record<string, (value: string) => void> = {
      calibrationFactor: setCalibrationFactor,
      decimals: setDecimals,
      chatGptKey: setChatGptKey,
      nightscoutUrl: setNightscoutUrl,
      nightscoutToken: setNightscoutToken,
      correctionFactor: setCorrectionFactor,
      carbRatio: setCarbRatio,
      targetGlucose: setTargetGlucose,
      hypoAlarm: setHypoAlarm,
      hyperAlarm: setHyperAlarm,
      apiUrl: setApiUrl,
      wsUrl: setWsUrl,
    };
    
    const setter = setters[keyboardConfig.field];
    if (setter) {
      setter(tempValue);
      
      // Save to storage based on field
      const field = keyboardConfig.field;
      if (field === 'calibrationFactor') {
        storage.saveSettings({ calibrationFactor: parseFloat(tempValue) || 1 });
      } else if (field === 'decimals') {
        storage.saveSettings({ decimals: parseInt(tempValue) || 1 });
      } else if (field === 'chatGptKey') {
        storage.saveSettings({ chatGptKey: tempValue });
      } else if (field === 'nightscoutUrl') {
        storage.saveSettings({ nightscoutUrl: tempValue });
      } else if (field === 'nightscoutToken') {
        storage.saveSettings({ nightscoutToken: tempValue });
      } else if (field === 'correctionFactor') {
        storage.saveSettings({ correctionFactor: parseFloat(tempValue) || 50 });
      } else if (field === 'carbRatio') {
        storage.saveSettings({ carbRatio: parseFloat(tempValue) || 10 });
      } else if (field === 'targetGlucose') {
        storage.saveSettings({ targetGlucose: parseFloat(tempValue) || 100 });
      } else if (field === 'hypoAlarm') {
        storage.saveSettings({ hypoAlarm: parseFloat(tempValue) || 70 });
      } else if (field === 'hyperAlarm') {
        storage.saveSettings({ hyperAlarm: parseFloat(tempValue) || 180 });
      } else if (field === 'apiUrl') {
        storage.saveSettings({ apiUrl: tempValue });
        setApiBaseUrl(tempValue);
      } else if (field === 'wsUrl') {
        storage.saveSettings({ wsUrl: tempValue });
      }
      
      // Haptic feedback on save
      if (navigator.vibrate) {
        navigator.vibrate(30);
      }
      
      toast({
        title: "Guardado",
        description: "Configuración actualizada correctamente",
      });
    }
  };

  const handlePasteToField = async (setter: (value: string) => void) => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        throw new Error("clipboard_unavailable");
      }
      const text = await navigator.clipboard.readText();
      setter(text);
    } catch (err) {
      toast({
        title: "No hay permisos de portapapeles",
        description: "Concede acceso al portapapeles desde el navegador.",
        variant: "destructive",
      });
    }
  };

  const handleExportData = () => {
    try {
      const data = storage.exportData();
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bascula-backup-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      
      toast({
        title: "Exportado",
        description: "Datos exportados correctamente",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "No se pudo exportar los datos",
        variant: "destructive",
      });
    }
  };

  const handleImportData = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const content = event.target?.result as string;
            const success = storage.importData(content);
            if (success) {
              toast({
                title: "Importado",
                description: "Datos importados correctamente. Recarga la página.",
              });
              // Reload page to apply settings
              setTimeout(() => window.location.reload(), 2000);
            } else {
              throw new Error('Invalid data');
            }
          } catch (error) {
            toast({
              title: "Error",
              description: "Archivo inválido",
              variant: "destructive",
            });
          }
        };
        reader.readAsText(file);
      }
    };
    input.click();
  };

  const handleResetSettings = () => {
    if (confirm('¿Estás seguro? Se perderán todas las configuraciones.')) {
      storage.resetSettings();
      toast({
        title: "Reiniciado",
        description: "Configuraciones restauradas a valores por defecto",
      });
      setTimeout(() => window.location.reload(), 1000);
    }
  };

  const handleTestAudio = async () => {
    setIsTestingAudio(true);
    try {
      await api.speak("Hola, este es un test del sistema de audio");
      toast({
        title: "Test de Audio",
        description: "Audio funcionando correctamente",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "No se pudo reproducir el audio",
        variant: "destructive",
      });
    } finally {
      setIsTestingAudio(false);
    }
  };

  const handleTestChatGPT = async () => {
    setIsTestingChatGPT(true);
    try {
      // Test with a simple recipe request
      await api.getRecipe("test");
      toast({
        title: "Test ChatGPT",
        description: "Conexión con ChatGPT exitosa",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "No se pudo conectar con ChatGPT. Verifica tu API key",
        variant: "destructive",
      });
    } finally {
      setIsTestingChatGPT(false);
    }
  };

  const handleTestNightscout = async () => {
    setIsTestingNightscout(true);
    try {
      await api.getGlucose();
      toast({
        title: "Test Nightscout",
        description: "Conexión con Nightscout exitosa",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "No se pudo conectar con Nightscout. Verifica la URL y token",
        variant: "destructive",
      });
    } finally {
      setIsTestingNightscout(false);
    }
  };

  const handleCheckUpdates = async () => {
    setIsCheckingUpdates(true);
    try {
      const result = await api.checkUpdates();
      setAvailableUpdates(result);
      if (result.available) {
        toast({
          title: "Actualización disponible",
          description: `Versión ${result.version} disponible`,
        });
      } else {
        toast({
          title: "Sistema actualizado",
          description: "No hay actualizaciones disponibles",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "No se pudo verificar actualizaciones",
        variant: "destructive",
      });
    } finally {
      setIsCheckingUpdates(false);
    }
  };

  const handleInstallUpdate = async () => {
    if (!availableUpdates?.available) return;
    
    if (!confirm("El dispositivo se reiniciará después de la actualización. ¿Continuar?")) {
      return;
    }

    setIsInstallingUpdate(true);
    try {
      await api.installUpdate();
      toast({
        title: "Actualización iniciada",
        description: "El dispositivo se reiniciará en unos momentos",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "No se pudo instalar la actualización",
        variant: "destructive",
      });
      setIsInstallingUpdate(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4">
      <Tabs defaultValue="general" className="w-full">
        <TabsList className="mb-4 grid w-full grid-cols-5 h-16">
          <TabsTrigger value="general" className="flex flex-col gap-1 text-xs">
            <Settings className="h-5 w-5" />
            General
          </TabsTrigger>
          <TabsTrigger value="scale" className="flex flex-col gap-1 text-xs">
            <Scale className="h-5 w-5" />
            Báscula
          </TabsTrigger>
          <TabsTrigger value="network" className="flex flex-col gap-1 text-xs">
            <Wifi className="h-5 w-5" />
            Red
          </TabsTrigger>
          <TabsTrigger value="diabetes" className="flex flex-col gap-1 text-xs">
            <Heart className="h-5 w-5" />
            Diabetes
          </TabsTrigger>
          <TabsTrigger value="updates" className="flex flex-col gap-1 text-xs">
            <Download className="h-5 w-5" />
            OTA
          </TabsTrigger>
        </TabsList>

        {/* General Tab */}
        <TabsContent value="general" className="space-y-4">
          <Card className="p-6">
            <h3 className="mb-4 text-2xl font-bold">Configuración General</h3>
            
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-lg font-medium">Modo Voz</Label>
                  <p className="text-sm text-muted-foreground">
                    Activar narración de texto y respuestas por voz
                  </p>
                </div>
                <Switch
                  checked={voiceEnabled}
                  onCheckedChange={setVoiceEnabled}
                  className="scale-150"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-lg font-medium">Seleccionar Voz</Label>
                <select className="w-full rounded-lg border border-input bg-background px-4 py-3 text-lg">
                  <option>Voz Femenina (es-ES)</option>
                  <option>Voz Masculina (es-ES)</option>
                </select>
              </div>

              <Button 
                variant="outline" 
                size="lg" 
                className="w-full justify-start"
                onClick={handleTestAudio}
                disabled={isTestingAudio || !voiceEnabled}
              >
                <Volume2 className="mr-2 h-5 w-5" />
                {isTestingAudio ? "Probando..." : "Probar Audio"}
              </Button>
            </div>
          </Card>
        </TabsContent>

        {/* Scale Tab */}
        <TabsContent value="scale" className="space-y-4">
          <Card className="p-6">
            <h3 className="mb-4 text-2xl font-bold">Configuración de Báscula</h3>
            
            <div className="space-y-6">
              <div className="space-y-2">
                <Label className="text-lg font-medium">Decimales</Label>
                <select 
                  className="w-full rounded-lg border border-input bg-background px-4 py-3 text-lg"
                  value={decimals}
                  onChange={(e) => {
                    setDecimals(e.target.value);
                    storage.saveSettings({ decimals: parseInt(e.target.value) });
                    toast({
                      title: "Guardado",
                      description: "Preferencia de decimales actualizada",
                    });
                  }}
                >
                  <option value="0">Sin decimales (0)</option>
                  <option value="1">Un decimal (0.0)</option>
                </select>
              </div>

              <div className="space-y-2">
                <Label className="text-lg font-medium">Calibración</Label>
                <p className="text-sm text-muted-foreground mb-2">
                  Factor de calibración actual: {calibrationFactor}
                </p>
                <div className="flex gap-2">
                <Input
                  type="text"
                  value={calibrationFactor}
                  readOnly
                  onClick={() => openKeyboard("Factor de Calibración", "numeric", "calibrationFactor", true, 0.1, 10000)}
                  placeholder="Nuevo factor"
                  className="flex-1 text-lg cursor-pointer"
                />
                  <Button 
                    size="lg" 
                    variant="secondary"
                    onClick={() => setShowCalibrationWizard(true)}
                  >
                    Calibrar
                  </Button>
                </div>
              </div>

              <Button 
                variant="glow" 
                size="lg" 
                className="w-full"
                onClick={() => setShowCalibrationWizard(true)}
              >
                <Scale className="mr-2 h-5 w-5" />
                Ejecutar Asistente de Calibración
              </Button>
            </div>
          </Card>
        </TabsContent>

        {/* Network Tab */}
        <TabsContent value="network" className="space-y-4">
          <Card className="p-6">
            <h3 className="mb-4 text-2xl font-bold">Configuración de Red</h3>

            <div className="space-y-6">
              <div className="flex items-center justify-between rounded-lg border border-border/70 bg-muted/20 p-4">
                <div>
                  <Label className="text-lg font-medium">Teclado interno</Label>
                  <p className="text-sm text-muted-foreground">
                    {internalKeyboardEnabled
                      ? "Usar teclado táctil integrado para introducir datos sensibles."
                      : "Usar teclado del sistema y pegado nativo."}
                  </p>
                </div>
                <Switch
                  checked={internalKeyboardEnabled}
                  onCheckedChange={setInternalKeyboardEnabled}
                  className="scale-125"
                />
              </div>

              <div>
                <Label className="text-lg font-medium mb-2 block">WiFi Conectado</Label>
                <div className="rounded-lg bg-success/10 p-4">
                  <p className="text-lg font-medium">{networkSSID}</p>
                  <p className="text-sm text-muted-foreground">{networkIP2}</p>
                </div>
              </div>

              <Button 
                variant="outline" 
                size="lg" 
                className="w-full"
                onClick={() => {
                  window.open('/config', '_blank');
                }}
              >
                Cambiar Red WiFi
              </Button>

              <div className="space-y-2">
                <Label className="text-lg font-medium">API Key de ChatGPT</Label>
                <div className="relative">
                  <Input
                    type="password"
                    value={chatGptKey}
                    readOnly={internalKeyboardEnabled}
                    onClick={() => {
                      if (!internalKeyboardEnabled) {
                        return;
                      }
                      openKeyboard("API Key de ChatGPT", "apikey", "chatGptKey", false, undefined, undefined, true);
                    }}
                    placeholder="sk-..."
                    className={cn("text-lg pr-12", internalKeyboardEnabled && "cursor-pointer")}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute inset-y-0 right-1 my-auto h-8 w-8"
                    onClick={() => void handlePasteToField(setChatGptKey)}
                  >
                    <ClipboardPaste className="h-4 w-4" />
                    <span className="sr-only">Pegar API Key</span>
                  </Button>
                </div>
              </div>

              <Button 
                variant="outline" 
                size="lg" 
                className="w-full justify-start"
                onClick={handleTestChatGPT}
                disabled={isTestingChatGPT || !chatGptKey}
              >
                <CheckCircle2 className="mr-2 h-5 w-5" />
                {isTestingChatGPT ? "Probando..." : "Probar Conexión ChatGPT"}
              </Button>

              <div>
                <Label className="text-lg font-medium mb-2 block">Acceso Mini-Web</Label>
                <div className="rounded-lg border border-border p-4 space-y-3">
                  <div>
                    <p className="text-sm text-muted-foreground">URL:</p>
                    <p className="text-lg font-mono break-all">
                      {networkIP ? `http://${networkIP}:8080` : "Obteniendo..."}
                    </p>
                  </div>
                  {networkIP && (
                    <div className="flex justify-center py-3 bg-white rounded">
                      <img 
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=http://${networkIP}:8080`}
                        alt="QR Code"
                        className="w-48 h-48"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </Card>
        </TabsContent>

        {/* Diabetes Tab */}
        <TabsContent value="diabetes" className="space-y-4">
          <Card className="p-6">
            <h3 className="mb-4 text-2xl font-bold">Configuración Diabetes</h3>
            
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-lg font-medium">Modo Diabetes</Label>
                  <p className="text-sm text-muted-foreground">
                    Habilitar funciones de diabetes
                  </p>
                </div>
                <Switch
                  checked={diabetesMode}
                  onCheckedChange={setDiabetesMode}
                  className="scale-150"
                />
              </div>

              {diabetesMode && (
                <>
                  <div className="flex items-center justify-between rounded-lg border border-border/70 bg-muted/20 p-4">
                    <div>
                      <Label className="text-lg font-medium">Teclado interno</Label>
                      <p className="text-sm text-muted-foreground">
                        Activa el teclado táctil para los campos de Nightscout.
                      </p>
                    </div>
                    <Switch
                      checked={internalKeyboardEnabled}
                      onCheckedChange={setInternalKeyboardEnabled}
                      className="scale-125"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-lg font-medium">Asistente de Bolos</Label>
                      <p className="text-sm text-muted-foreground">
                        Calcular dosis de insulina
                      </p>
                    </div>
                    <Switch
                      checked={bolusAssistant}
                      onCheckedChange={setBolusAssistant}
                      className="scale-150"
                    />
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>URL Nightscout</Label>
                      <div className="relative">
                        <Input
                          value={nightscoutUrl}
                          readOnly={internalKeyboardEnabled}
                          onClick={() => {
                            if (!internalKeyboardEnabled) {
                              return;
                            }
                            openKeyboard("URL Nightscout", "url", "nightscoutUrl", false, undefined, undefined, true);
                          }}
                          placeholder="https://mi-nightscout.herokuapp.com"
                          className={cn("pr-12", internalKeyboardEnabled && "cursor-pointer")}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute inset-y-0 right-1 my-auto h-8 w-8"
                          onClick={() => void handlePasteToField(setNightscoutUrl)}
                        >
                          <ClipboardPaste className="h-4 w-4" />
                          <span className="sr-only">Pegar URL Nightscout</span>
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>API Token</Label>
                      <div className="relative">
                        <Input
                          type="password"
                          value={nightscoutToken}
                          readOnly={internalKeyboardEnabled}
                          onClick={() => {
                            if (!internalKeyboardEnabled) {
                              return;
                            }
                            openKeyboard("API Token", "password", "nightscoutToken", false, undefined, undefined, true);
                          }}
                          placeholder="Token de acceso"
                          className={cn("pr-12", internalKeyboardEnabled && "cursor-pointer")}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute inset-y-0 right-1 my-auto h-8 w-8"
                          onClick={() => void handlePasteToField(setNightscoutToken)}
                        >
                          <ClipboardPaste className="h-4 w-4" />
                          <span className="sr-only">Pegar token Nightscout</span>
                        </Button>
                      </div>
                    </div>

                    {bolusAssistant && (
                      <>
                        <div className="space-y-2">
                          <Label>Factor de Corrección</Label>
                          <Input
                            type="text"
                            value={correctionFactor}
                            readOnly
                            onClick={() => openKeyboard("Factor de Corrección", "numeric", "correctionFactor", false, 1, 200)}
                            placeholder="30"
                            className="cursor-pointer"
                          />
                        </div>
                        
                        <div className="space-y-2">
                          <Label>Ratio Carbohidratos</Label>
                          <Input
                            type="text"
                            value={carbRatio}
                            readOnly
                            onClick={() => openKeyboard("Ratio Carbohidratos", "numeric", "carbRatio", false, 1, 100)}
                            placeholder="10"
                            className="cursor-pointer"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label>Objetivo Glucosa (mg/dl)</Label>
                          <Input
                            type="text"
                            value={targetGlucose}
                            readOnly
                            onClick={() => openKeyboard("Objetivo Glucosa", "numeric", "targetGlucose", false, 70, 180)}
                            placeholder="100"
                            className="cursor-pointer"
                          />
                        </div>
                      </>
                    )}

                    <div className="space-y-2">
                      <Label>Alarma Hipoglucemia (mg/dl)</Label>
                      <Input
                        type="text"
                        value={hypoAlarm}
                        readOnly
                        onClick={() => openKeyboard("Alarma Hipoglucemia", "numeric", "hypoAlarm", false, 40, 90)}
                        placeholder="70"
                        className="cursor-pointer"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Alarma Hiperglucemia (mg/dl)</Label>
                      <Input
                        type="text"
                        value={hyperAlarm}
                        readOnly
                        onClick={() => openKeyboard("Alarma Hiperglucemia", "numeric", "hyperAlarm", false, 150, 300)}
                        placeholder="180"
                        className="cursor-pointer"
                      />
                    </div>

                    <Button 
                      variant="outline" 
                      size="lg" 
                      className="w-full justify-start"
                      onClick={handleTestNightscout}
                      disabled={isTestingNightscout || !nightscoutUrl}
                    >
                      <CheckCircle2 className="mr-2 h-5 w-5" />
                      {isTestingNightscout ? "Probando..." : "Probar Conexión Nightscout"}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </Card>
        </TabsContent>

        {/* Updates Tab */}
        <TabsContent value="updates" className="space-y-4">
          <Card className="p-6">
            <h3 className="mb-4 text-2xl font-bold">Actualizaciones OTA</h3>
            
            <div className="space-y-6">
              <div className="rounded-lg bg-muted p-6 text-center">
                <p className="mb-2 text-sm text-muted-foreground">Versión Actual</p>
                <p className="text-4xl font-bold text-primary">v2.5.0</p>
              </div>

              <Button 
                variant="glow" 
                size="xl" 
                className="w-full text-xl"
                onClick={handleCheckUpdates}
                disabled={isCheckingUpdates}
              >
                <Download className="mr-2 h-6 w-6 animate-bounce" />
                {isCheckingUpdates ? "Verificando..." : "Buscar Actualizaciones"}
              </Button>

              {availableUpdates && (
                <div className={`rounded-lg border p-4 animate-fade-in ${availableUpdates.available ? "border-primary bg-primary/5" : "border-success bg-success/5"}`}>
                  {availableUpdates.available ? (
                    <>
                      <p className="font-medium text-primary mb-2">
                        📦 Nueva versión disponible: {availableUpdates.version}
                      </p>
                      <Button
                        variant="glow"
                        size="lg"
                        className="w-full"
                        onClick={handleInstallUpdate}
                        disabled={isInstallingUpdate}
                      >
                        {isInstallingUpdate ? (
                          <>
                            <Download className="mr-2 h-5 w-5 animate-spin" />
                            Instalando...
                          </>
                        ) : (
                          <>
                            <Download className="mr-2 h-5 w-5" />
                            Instalar Actualización
                          </>
                        )}
                      </Button>
                    </>
                  ) : (
                    <p className="font-medium text-success">
                      ✓ El sistema está actualizado
                    </p>
                  )}
                </div>
              )}

              <div className="rounded-lg border-warning/50 border bg-warning/5 p-4">
                <p className="text-sm font-medium text-warning">
                  ⚠️ Después de actualizar, el sistema se reiniciará automáticamente
                </p>
              </div>
            </div>
          </Card>
        </TabsContent>
      </Tabs>

      <KeyboardDialog
        open={keyboardOpen}
        onClose={() => setKeyboardOpen(false)}
        value={tempValue}
        onChange={setTempValue}
        onConfirm={handleKeyboardConfirm}
        title={keyboardConfig.title}
        type={keyboardConfig.type}
        showDecimal={keyboardConfig.showDecimal}
        min={keyboardConfig.min}
        max={keyboardConfig.max}
        allowEmpty={keyboardConfig.allowEmpty}
      />

      <CalibrationWizard
        open={showCalibrationWizard}
        onClose={() => setShowCalibrationWizard(false)}
        currentWeight={weight}
      />
    </div>
  );
};
