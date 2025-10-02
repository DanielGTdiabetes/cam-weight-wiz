import { useState } from "react";
import { Settings, Scale, Wifi, Heart, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export const SettingsView = () => {
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [diabetesMode, setDiabetesMode] = useState(false);
  const [bolusAssistant, setBolusAssistant] = useState(false);

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
                  Factor de calibración actual: 420.5
                </p>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    placeholder="Nuevo factor"
                    className="flex-1 text-lg"
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
                  placeholder="sk-..."
                  className="text-lg"
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
                      <Input placeholder="https://mi-nightscout.herokuapp.com" />
                    </div>
                    
                    <div className="space-y-2">
                      <Label>API Token</Label>
                      <Input type="password" placeholder="Token de acceso" />
                    </div>

                    {bolusAssistant && (
                      <>
                        <div className="space-y-2">
                          <Label>Factor de Corrección</Label>
                          <Input type="number" placeholder="30" />
                        </div>
                        
                        <div className="space-y-2">
                          <Label>Ratio Carbohidratos</Label>
                          <Input type="number" placeholder="10" />
                        </div>

                        <div className="space-y-2">
                          <Label>Objetivo Glucosa (mg/dl)</Label>
                          <Input type="number" placeholder="100" />
                        </div>
                      </>
                    )}

                    <div className="space-y-2">
                      <Label>Alarma Hipoglucemia (mg/dl)</Label>
                      <Input type="number" placeholder="70" />
                    </div>

                    <div className="space-y-2">
                      <Label>Alarma Hiperglucemia (mg/dl)</Label>
                      <Input type="number" placeholder="180" />
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
    </div>
  );
};
