import { useState, useEffect } from "react";
import { Settings, Scale, Wifi, Heart, Download, Save, Upload, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KeyboardDialog } from "@/components/KeyboardDialog";
import { storage } from "@/services/storage";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export const SettingsView = () => {
  const { toast } = useToast();
  
  // Load settings on mount
  useEffect(() => {
    const settings = storage.getSettings();
    setVoiceEnabled(settings.isVoiceActive);
    setDiabetesMode(settings.diabetesMode);
    setCalibrationFactor(settings.calibrationFactor.toString());
    setChatGptKey(settings.chatGptKey);
    setNightscoutUrl(settings.nightscoutUrl);
    setNightscoutToken(settings.nightscoutToken);
    setCorrectionFactor(settings.correctionFactor.toString());
    setCarbRatio(settings.carbRatio.toString());
    setTargetGlucose(settings.targetGlucose.toString());
    setHypoAlarm(settings.hypoAlarm.toString());
    setHyperAlarm(settings.hyperAlarm.toString());
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
  }>({ title: "", type: "text", field: "" });
  
  const [calibrationFactor, setCalibrationFactor] = useState("420.5");
  const [chatGptKey, setChatGptKey] = useState("");
  const [nightscoutUrl, setNightscoutUrl] = useState("");
  const [nightscoutToken, setNightscoutToken] = useState("");
  const [correctionFactor, setCorrectionFactor] = useState("30");
  const [carbRatio, setCarbRatio] = useState("10");
  const [targetGlucose, setTargetGlucose] = useState("100");
  const [hypoAlarm, setHypoAlarm] = useState("70");
  const [hyperAlarm, setHyperAlarm] = useState("180");
  
  const [tempValue, setTempValue] = useState("");

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
    max?: number
  ) => {
    setKeyboardConfig({ title, type, field, showDecimal, min, max });
    const currentValue = getCurrentValue(field);
    setTempValue(currentValue);
    setKeyboardOpen(true);
  };

  const getCurrentValue = (field: string): string => {
    const values: Record<string, string> = {
      calibrationFactor,
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
      chatGptKey: setChatGptKey,
      nightscoutUrl: setNightscoutUrl,
      nightscoutToken: setNightscoutToken,
      correctionFactor: setCorrectionFactor,
      carbRatio: setCarbRatio,
      targetGlucose: setTargetGlucose,
      hypoAlarm: setHypoAlarm,
      hyperAlarm: setHyperAlarm,
    };
    
    const setter = setters[keyboardConfig.field];
    if (setter) {
      setter(tempValue);
      
      // Save to storage based on field
      const field = keyboardConfig.field;
      if (field === 'calibrationFactor') {
        storage.saveSettings({ calibrationFactor: parseFloat(tempValue) || 1 });
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

              <div className="border-t border-border pt-6">
                <h4 className="text-lg font-semibold mb-4">Gestión de Datos</h4>
                <div className="space-y-3">
                  <Button 
                    variant="outline" 
                    size="lg" 
                    className="w-full justify-start"
                    onClick={handleExportData}
                  >
                    <Save className="mr-2 h-5 w-5" />
                    Exportar Configuración y Datos
                  </Button>
                  
                  <Button 
                    variant="outline" 
                    size="lg" 
                    className="w-full justify-start"
                    onClick={handleImportData}
                  >
                    <Upload className="mr-2 h-5 w-5" />
                    Importar Configuración
                  </Button>
                  
                  <Button 
                    variant="destructive" 
                    size="lg" 
                    className="w-full justify-start"
                    onClick={handleResetSettings}
                  >
                    <Trash2 className="mr-2 h-5 w-5" />
                    Restablecer a Valores por Defecto
                  </Button>
                </div>
              </div>
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
                <select className="w-full rounded-lg border border-input bg-background px-4 py-3 text-lg">
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
                  <Button size="lg" variant="secondary">
                    Calibrar
                  </Button>
                </div>
              </div>

              <Button variant="outline" size="lg" className="w-full">
                Ejecutar Proceso de Calibración
              </Button>
            </div>
          </Card>
        </TabsContent>

        {/* Network Tab */}
        <TabsContent value="network" className="space-y-4">
          <Card className="p-6">
            <h3 className="mb-4 text-2xl font-bold">Configuración de Red</h3>
            
            <div className="space-y-6">
              <div>
                <Label className="text-lg font-medium mb-2 block">WiFi Conectado</Label>
                <div className="rounded-lg bg-success/10 p-4">
                  <p className="text-lg font-medium">Mi_Red_WiFi</p>
                  <p className="text-sm text-muted-foreground">192.168.1.100</p>
                </div>
              </div>

              <Button variant="outline" size="lg" className="w-full">
                Cambiar Red WiFi
              </Button>

              <div className="space-y-2">
                <Label className="text-lg font-medium">API Key de ChatGPT</Label>
                <Input
                  type="password"
                  value={chatGptKey}
                  readOnly
                  onClick={() => openKeyboard("API Key de ChatGPT", "apikey", "chatGptKey")}
                  placeholder="sk-..."
                  className="text-lg cursor-pointer"
                />
              </div>

              <div>
                <Label className="text-lg font-medium mb-2 block">Acceso Mini-Web</Label>
                <div className="rounded-lg border border-border p-4 space-y-2">
                  <p className="text-sm text-muted-foreground">URL:</p>
                  <p className="text-lg font-mono">http://192.168.1.100:8080</p>
                  <p className="text-sm text-muted-foreground">PIN:</p>
                  <p className="text-2xl font-bold text-primary">1234</p>
                  <Button variant="secondary" size="sm" className="w-full">
                    Generar QR
                  </Button>
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
                      <Input
                        value={nightscoutUrl}
                        readOnly
                        onClick={() => openKeyboard("URL Nightscout", "url", "nightscoutUrl")}
                        placeholder="https://mi-nightscout.herokuapp.com"
                        className="cursor-pointer"
                      />
                    </div>
                    
                    <div className="space-y-2">
                      <Label>API Token</Label>
                      <Input
                        type="password"
                        value={nightscoutToken}
                        readOnly
                        onClick={() => openKeyboard("API Token", "password", "nightscoutToken")}
                        placeholder="Token de acceso"
                        className="cursor-pointer"
                      />
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

              <Button variant="glow" size="xl" className="w-full text-xl">
                <Download className="mr-2 h-6 w-6" />
                Buscar Actualizaciones
              </Button>

              <div className="rounded-lg border border-border p-4">
                <p className="text-sm text-muted-foreground">
                  Última comprobación: Hoy a las 10:30
                </p>
                <p className="mt-2 font-medium text-success">
                  ✓ El sistema está actualizado
                </p>
              </div>

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
      />
    </div>
  );
};
