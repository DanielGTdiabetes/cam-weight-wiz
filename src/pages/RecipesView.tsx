import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, MicOff, ChefHat, ArrowLeft, ArrowRight, X, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { api, type GeneratedRecipe, type RecipeStep } from "@/services/api";
import { ApiError } from "@/services/apiWrapper";
import { useNavSafeExit } from "@/hooks/useNavSafeExit";

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

declare global {
  interface Window {
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    SpeechRecognition?: SpeechRecognitionConstructor;
  }
}

type SpeechRecognitionInstance = SpeechRecognition;

interface IngredientDisplay {
  name: string;
  quantity: number | null;
  unit: string;
  needsScale: boolean;
}

interface RecipesViewProps {
  context?: "page" | "modal";
  onClose?: () => void;
}

const mapIngredients = (recipe: GeneratedRecipe | null): IngredientDisplay[] => {
  if (!recipe?.ingredients) {
    return [];
  }
  return recipe.ingredients.map((ingredient) => ({
    name: ingredient.name,
    quantity: ingredient.quantity,
    unit: ingredient.unit,
    needsScale: Boolean(ingredient.needs_scale),
  }));
};

export const RecipesView = ({ context = "page", onClose }: RecipesViewProps = {}) => {
  const { navEnabled, isTouchDevice, handleClose, isModal } = useNavSafeExit({
    context,
    onClose,
  });
  const [recipe, setRecipe] = useState<GeneratedRecipe | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [recipeStarted, setRecipeStarted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isAdvancing, setIsAdvancing] = useState(false);
  const [userPrompt, setUserPrompt] = useState("");
  const [stepResponses, setStepResponses] = useState<Record<number, string>>({});
  const [assistantMessage, setAssistantMessage] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const [recipeCompleted, setRecipeCompleted] = useState(false);

  const { toast } = useToast();

  const ingredients = useMemo(() => mapIngredients(recipe), [recipe]);
  const currentStep: RecipeStep | undefined = recipe?.steps[currentStepIndex];
  const currentResponse = stepResponses[currentStepIndex] ?? "";

  const stopRecognition = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (error) {
        console.warn("Speech recognition stop failed", error);
      }
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, []);

  useEffect(() => () => stopRecognition(), [stopRecognition]);

  const getRecognitionInstance = (): SpeechRecognitionInstance | null => {
    if (typeof window === "undefined") {
      return null;
    }
    const globalWindow = window as Window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const RecognitionClass = globalWindow.SpeechRecognition || globalWindow.webkitSpeechRecognition;
    if (!RecognitionClass) {
      return null;
    }
    const recognition: SpeechRecognitionInstance = new RecognitionClass();
    recognition.lang = "es-ES";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    return recognition;
  };

  const handleMicToggle = () => {
    if (isListening) {
      stopRecognition();
      return;
    }

    const recognition = getRecognitionInstance();
    if (!recognition) {
      toast({
        title: "Micrófono no disponible",
        description: "Este navegador no soporta reconocimiento de voz",
        variant: "destructive",
      });
      return;
    }

    recognitionRef.current = recognition;
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join(" ")
        .trim();

      if (!transcript) {
        return;
      }

      if (!recipeStarted) {
        setUserPrompt(transcript);
      } else {
        setStepResponses((prev) => ({ ...prev, [currentStepIndex]: transcript }));
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error("Speech recognition error", event);
      toast({ title: "Error de micrófono", description: "Intenta nuevamente" });
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    try {
      recognition.start();
      setIsListening(true);
    } catch (error) {
      console.error("Speech recognition start failed", error);
      toast({ title: "No se pudo iniciar el micrófono" });
    }
  };

  const resetState = () => {
    setRecipe(null);
    setRecipeStarted(false);
    setRecipeCompleted(false);
    setCurrentStepIndex(0);
    setAssistantMessage(null);
    setStepResponses({});
    setUserPrompt("");
    stopRecognition();
  };

  const handleStart = async () => {
    const prompt = userPrompt.trim();
    if (!prompt) {
      toast({
        title: "Describe la receta",
        description: "Indica qué quieres preparar o usa el micrófono",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      const generated = await api.getRecipe(prompt);
      setRecipe(generated);
      setRecipeStarted(true);
      setRecipeCompleted(false);
      setCurrentStepIndex(0);
      setAssistantMessage(null);
      setStepResponses({});
    } catch (error) {
      console.error("Failed to generate recipe", error);
      if (error instanceof ApiError) {
        toast({ title: "No se pudo generar la receta", description: error.message, variant: "destructive" });
      } else {
        toast({ title: "Error inesperado", description: "Intenta de nuevo" });
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handlePrevious = () => {
    if (!recipe || currentStepIndex === 0) {
      return;
    }
    setCurrentStepIndex((prev) => Math.max(prev - 1, 0));
    setAssistantMessage(null);
    setRecipeCompleted(false);
  };

  const handleNext = async () => {
    if (!recipe || !currentStep || recipeCompleted) {
      return;
    }
    setIsAdvancing(true);
    try {
      const response = currentResponse.trim();
      const result = await api.nextRecipeStep(recipe.id, currentStepIndex, response || undefined);
      setAssistantMessage(result.assistantMessage ?? null);

      if (result.isLast) {
        setRecipeCompleted(true);
        toast({ title: "Receta completada", description: "¡Buen provecho!" });
        return;
      }

      if (currentStepIndex < recipe.steps.length - 1) {
        setCurrentStepIndex((prev) => prev + 1);
      }
    } catch (error) {
      console.error("Failed to advance recipe", error);
      if (error instanceof ApiError) {
        toast({ title: "No se pudo avanzar", description: error.message, variant: "destructive" });
      } else {
        toast({ title: "Error", description: "No se pudo avanzar al siguiente paso" });
      }
    } finally {
      setIsAdvancing(false);
    }
  };

  const handleCancel = () => {
    resetState();
  };

  const currentProgress = recipe ? Math.min(((currentStepIndex + 1) / recipe.steps.length) * 100, 100) : 0;

  const navControls = navEnabled ? (
    <div className="flex items-center gap-2 p-4">
      <Button variant="outline" onClick={handleClose} className="gap-2">
        <ArrowLeft className="h-4 w-4" />
        Atrás
      </Button>
      {isModal && (
        <Button variant="ghost" onClick={handleClose} className="gap-2">
          <X className="h-4 w-4" />
          Cerrar
        </Button>
      )}
    </div>
  ) : null;

  let content: JSX.Element | null;

  if (!recipeStarted) {
    content = (
      <div className="flex flex-1 items-center justify-center p-8">
        <Card className="w-full max-w-2xl p-8">
          <div className="mb-8 text-center">
            <div className="mb-4 flex justify-center">
              <div className="rounded-full bg-primary/20 p-6">
                <ChefHat className="h-16 w-16 text-primary" />
              </div>
            </div>
            <h2 className="mb-4 text-4xl font-bold">Asistente de Recetas</h2>
            <p className="text-xl text-muted-foreground">
              Describe qué quieres cocinar y te guiaremos paso a paso.
            </p>
          </div>

          <div className="space-y-4">
            <Textarea
              placeholder={'Ejemplo: "Quiero preparar pasta con salsa de tomate"'}
              value={userPrompt}
              onChange={(event) => setUserPrompt(event.target.value)}
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
                    <MicOff className="mr-2 h-6 w-6" /> Detener voz
                  </>
                ) : (
                  <>
                    <Mic className="mr-2 h-6 w-6" /> Hablar
                  </>
                )}
              </Button>

              <Button
                onClick={handleStart}
                disabled={isLoading}
                variant="glow"
                size="xl"
                className="h-20 text-xl"
              >
                {isLoading ? "Generando..." : (<><ChefHat className="mr-2 h-6 w-6" /> Comenzar</>)}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  } else if (!recipe || !currentStep) {
    content = null;
  } else {
    content = (
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
          <Card className="border-primary/30 p-6">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold">{recipe.title}</h2>
                <p className="text-sm text-muted-foreground">Raciones sugeridas: {recipe.servings}</p>
              </div>
              <Button variant="outline" onClick={handleCancel}>
                <X className="mr-2 h-4 w-4" /> Cancelar
              </Button>
            </div>

            {ingredients.length > 0 && (
              <div className="mb-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                  <ListChecks className="h-4 w-4" /> Ingredientes preparados
                </div>
                <ul className="space-y-1 text-sm">
                  {ingredients.map((ingredient, index) => (
                    <li key={`${ingredient.name}-${index}`} className="flex items-center justify-between">
                      <span>{ingredient.name}</span>
                      <span className="text-muted-foreground">
                        {ingredient.quantity !== null ? `${ingredient.quantity}${ingredient.unit}` : ingredient.unit}
                        {ingredient.needsScale && ' · Usa la báscula'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mb-3 flex items-center justify-between text-sm text-muted-foreground">
              <span>Paso {currentStepIndex + 1} de {recipe.steps.length}</span>
              <span>{currentProgress.toFixed(0)}%</span>
            </div>
            <div className="mb-6 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all duration-500"
                style={{ width: `${currentProgress}%` }}
              />
            </div>

            <Card className="border-primary/40 bg-primary/5 p-6">
              <div className="mb-3 flex items-center gap-3">
                <ChefHat className="h-6 w-6 text-primary" />
                <h3 className="text-xl font-bold">Paso {currentStep.index}</h3>
              </div>
              <p className="text-2xl leading-relaxed">{currentStep.instruction}</p>

              {currentStep.needsScale && currentStep.expectedWeight && (
                <div className="mt-4 rounded-lg bg-primary/10 p-4 text-center text-primary">
                  <p className="text-sm">Peso objetivo</p>
                  <p className="text-4xl font-bold">{currentStep.expectedWeight} g</p>
                </div>
              )}
            </Card>
          </Card>

          <Card className="border-primary/20 p-6">
            <h3 className="mb-3 text-xl font-bold">Tu respuesta</h3>
            <Textarea
              value={currentResponse}
              onChange={(event) => setStepResponses((prev) => ({ ...prev, [currentStepIndex]: event.target.value }))}
              placeholder="Escribe observaciones, pesos medidos o dudas para el asistente"
              className="min-h-32"
            />

            <div className="mt-3 flex gap-3">
              <Button
                onClick={handleMicToggle}
                variant={isListening ? "destructive" : "outline"}
                className="flex-1"
              >
                {isListening ? (
                  <>
                    <MicOff className="mr-2 h-4 w-4" /> Detener voz
                  </>
                ) : (
                  <>
                    <Mic className="mr-2 h-4 w-4" /> Dictar
                  </>
                )}
              </Button>
              <Button
                onClick={() => setStepResponses((prev) => ({ ...prev, [currentStepIndex]: "" }))}
                variant="outline"
              >
                Limpiar
              </Button>
            </div>

            {assistantMessage && (
              <div className="mt-4 rounded-lg border border-primary/30 bg-primary/10 p-4 text-sm">
                <p className="font-semibold">Asistente:</p>
                <p>{assistantMessage}</p>
              </div>
            )}
          </Card>
        </div>

        <div className="mt-auto grid grid-cols-4 gap-3">
          <Button
            onClick={handleCancel}
            variant="outline"
            size="xl"
            className="h-16 text-xl"
          >
            <X className="mr-2 h-5 w-5" /> Cancelar
          </Button>
          <Button
            onClick={handlePrevious}
            disabled={currentStepIndex === 0}
            variant="secondary"
            size="xl"
            className="h-16 text-xl"
          >
            <ArrowLeft className="mr-2 h-5 w-5" /> Anterior
          </Button>
          <Button
            onClick={handleMicToggle}
            variant={isListening ? "destructive" : "outline"}
            size="xl"
            className="h-16 text-xl"
          >
            {isListening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </Button>
          <Button
            onClick={handleNext}
            disabled={isAdvancing || recipeCompleted}
            variant="glow"
            size="xl"
            className="h-16 text-xl"
          >
            {recipeCompleted ? (
              "Completado"
            ) : (
              <>
                Siguiente
                <ArrowRight className="ml-2 h-5 w-5" />
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      {navControls}
      {content}
      {navEnabled && isTouchDevice && (
        <Button
          variant="glow"
          size="lg"
          onClick={handleClose}
          className="fixed bottom-6 right-6 z-50 rounded-full px-6 py-6 shadow-lg"
        >
          Salir
        </Button>
      )}
    </div>
  );
};
