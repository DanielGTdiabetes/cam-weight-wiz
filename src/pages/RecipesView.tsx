import { useState } from "react";
import { Mic, MicOff, ChefHat, ArrowLeft, ArrowRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface RecipeStep {
  step: number;
  instruction: string;
  needsScale?: boolean;
  expectedWeight?: number;
}

export const RecipesView = () => {
  const [isListening, setIsListening] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [recipeStarted, setRecipeStarted] = useState(false);
  const [userInput, setUserInput] = useState("");

  // Simulated recipe steps
  const recipeSteps: RecipeStep[] = [
    {
      step: 1,
      instruction: "¿Qué receta te gustaría preparar hoy? Puedes decírmelo o escribirlo.",
    },
    {
      step: 2,
      instruction: "Vamos a hacer pasta con tomate. Primero, pesa 100g de pasta seca.",
      needsScale: true,
      expectedWeight: 100,
    },
    {
      step: 3,
      instruction: "Perfecto. Ahora pon agua a hervir en una olla grande con sal.",
    },
    {
      step: 4,
      instruction: "Mientras tanto, pesa 150g de tomate natural.",
      needsScale: true,
      expectedWeight: 150,
    },
  ];

  const handleMicToggle = () => {
    setIsListening(!isListening);
    // TODO: Integrate with microphone API
  };

  const handleStart = () => {
    setRecipeStarted(true);
    setCurrentStep(1);
    // TODO: Send to ChatGPT/AI
  };

  const handleNext = () => {
    if (currentStep < recipeSteps.length - 1) {
      setCurrentStep(currentStep + 1);
      // TODO: Send step completion to AI
    }
  };

  const handlePrevious = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleCancel = () => {
    setRecipeStarted(false);
    setCurrentStep(0);
    setUserInput("");
  };

  if (!recipeStarted) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Card className="w-full max-w-2xl p-8">
          <div className="mb-8 text-center">
            <div className="mb-4 flex justify-center">
              <div className="rounded-full bg-primary/20 p-6">
                <ChefHat className="h-16 w-16 text-primary" />
              </div>
            </div>
            <h2 className="mb-4 text-4xl font-bold">Asistente de Recetas</h2>
            <p className="text-xl text-muted-foreground">
              Tu chef personal con IA. Adapta las cantidades según lo que peses.
            </p>
          </div>

          <div className="space-y-4">
            <Textarea
              placeholder="Escribe la receta que quieres preparar..."
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              className="min-h-32 text-lg"
            />
            
            <div className="grid grid-cols-2 gap-4">
              <Button
                onClick={handleMicToggle}
                variant={isListening ? "destructive" : "secondary"}
                size="xl"
                className="h-20 text-xl"
              >
                {isListening ? (
                  <>
                    <MicOff className="mr-2 h-6 w-6" />
                    Detener
                  </>
                ) : (
                  <>
                    <Mic className="mr-2 h-6 w-6" />
                    Hablar
                  </>
                )}
              </Button>
              
              <Button
                onClick={handleStart}
                disabled={!userInput && !isListening}
                variant="glow"
                size="xl"
                className="h-20 text-xl"
              >
                <ChefHat className="mr-2 h-6 w-6" />
                Comenzar
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  const step = recipeSteps[currentStep];

  return (
    <div className="flex h-full flex-col p-4">
      {/* Progress */}
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between text-sm text-muted-foreground">
          <span>Paso {currentStep + 1} de {recipeSteps.length}</span>
          <span>{Math.round(((currentStep + 1) / recipeSteps.length) * 100)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${((currentStep + 1) / recipeSteps.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Main Instruction */}
      <Card className="mb-4 flex-1 border-primary/30 glow-cyan">
        <div className="flex h-full flex-col p-8">
          <div className="mb-4 flex items-center gap-3">
            <ChefHat className="h-8 w-8 text-primary" />
            <h3 className="text-2xl font-bold">Paso {step.step}</h3>
          </div>
          
          <div className="flex-1 overflow-y-auto">
            <p className="text-3xl leading-relaxed">{step.instruction}</p>
          </div>

          {step.needsScale && (
            <div className="mt-6 rounded-lg bg-primary/10 p-6 text-center">
              <p className="mb-2 text-lg text-muted-foreground">Peso esperado:</p>
              <p className="text-5xl font-bold text-primary">{step.expectedWeight}g</p>
            </div>
          )}
        </div>
      </Card>

      {/* Voice Feedback */}
      {isListening && (
        <Card className="mb-4 border-destructive/50 bg-destructive/5 p-4">
          <div className="flex items-center gap-3">
            <Mic className="h-6 w-6 animate-pulse text-destructive" />
            <p className="text-lg">Escuchando tu respuesta...</p>
          </div>
        </Card>
      )}

      {/* Navigation */}
      <div className="grid grid-cols-4 gap-3">
        <Button
          onClick={handleCancel}
          variant="outline"
          size="xl"
          className="h-20 text-xl"
        >
          <X className="mr-2 h-6 w-6" />
          Cancelar
        </Button>
        
        <Button
          onClick={handlePrevious}
          disabled={currentStep === 0}
          variant="secondary"
          size="xl"
          className="h-20 text-xl"
        >
          <ArrowLeft className="mr-2 h-6 w-6" />
          Anterior
        </Button>
        
        <Button
          onClick={handleMicToggle}
          variant={isListening ? "destructive" : "outline"}
          size="xl"
          className="col-span-1 h-20 text-xl"
        >
          {isListening ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
        </Button>
        
        <Button
          onClick={handleNext}
          disabled={currentStep === recipeSteps.length - 1}
          variant="glow"
          size="xl"
          className="h-20 text-xl"
        >
          Siguiente
          <ArrowRight className="ml-2 h-6 w-6" />
        </Button>
      </div>
    </div>
  );
};
