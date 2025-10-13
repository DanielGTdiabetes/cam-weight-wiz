import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Mic, MicOff, ChefHat, ArrowLeft, ArrowRight, X, ListChecks, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { formatWeight } from "@/lib/format";
import { useScaleDecimals } from "@/hooks/useScaleDecimals";
import { useToast } from "@/hooks/use-toast";
import { api, type GeneratedRecipe, type RecipeStep } from "@/services/api";
import { ApiError } from "@/services/apiWrapper";
import { useNavSafeExit } from "@/hooks/useNavSafeExit";
import { useNavigate } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useRecipeAvailability } from "@/hooks/useRecipeAvailability";
import { useAudioPref } from "@/state/useAudio";

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
    needsScale: Boolean(ingredient.needs_scale ?? ingredient.needsScale),
  }));
};

export const RecipesView = ({ context = "page", onClose }: RecipesViewProps = {}) => {
  const navigate = useNavigate();
  const { navEnabled, isModal } = useNavSafeExit({
    context,
    onClose,
  });
  const decimals = useScaleDecimals();
  const [recipe, setRecipe] = useState<GeneratedRecipe | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [recipeStarted, setRecipeStarted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isAdvancing, setIsAdvancing] = useState(false);
  const [userPrompt, setUserPrompt] = useState("");
  const [stepResponses, setStepResponses] = useState<Record<number, string>>({});
  const [assistantMessage, setAssistantMessage] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [recipeCompleted, setRecipeCompleted] = useState(false);
  const lastSpokenStepRef = useRef<string | null>(null);
  const lastAssistantSpeechRef = useRef<string | null>(null);
  const previousStepRef = useRef<number>(-1);

  const { toast } = useToast();
  const { voiceEnabled } = useAudioPref();
  const {
    loading: availabilityLoading,
    enabled: recipesEnabled,
    reason: availabilityReason,
    model: availabilityModel,
  } = useRecipeAvailability();

  const ingredients = useMemo(() => mapIngredients(recipe), [recipe]);
  const currentStep: RecipeStep | undefined = recipe?.steps[currentStepIndex];
  const currentResponse = stepResponses[currentStepIndex] ?? "";
  const canUseRecipes = recipesEnabled && !availabilityLoading;
  const inputsDisabled = !recipesEnabled && !availabilityLoading;
  const recipeModel = recipe?.model ?? availabilityModel ?? null;

  const pttTargetRef = useRef<"prompt" | "step" | null>(null);

  const applyTranscript = useCallback(
    (target: "prompt" | "step", transcript: string) => {
      const normalized = transcript.trim();
      if (!normalized) {
        return;
      }
      if (target === "prompt") {
        setUserPrompt(normalized);
      } else {
        setStepResponses((prev) => ({ ...prev, [currentStepIndex]: normalized }));
      }
    },
    [currentStepIndex]
  );

  const startVoiceCapture = useCallback(
    async (target: "prompt" | "step") => {
      if (isListening) {
        return;
      }
      pttTargetRef.current = target;
      setIsListening(true);
      try {
        await api.startVoicePtt();
      } catch (error) {
        pttTargetRef.current = null;
        setIsListening(false);
        if (error instanceof ApiError && error.status === 423) {
          toast({
            title: "Micrófono ocupado",
            description: "Inténtalo de nuevo en unos segundos.",
            variant: "destructive",
          });
        } else {
          toast({
            title: "No se pudo iniciar el micrófono",
            description: "Revisa la conexión o inténtalo otra vez.",
            variant: "destructive",
          });
        }
      }
    },
    [isListening, toast]
  );

  const stopVoiceCapture = useCallback(
    async () => {
      if (!isListening) {
        return;
      }
      setIsListening(false);
      const target = pttTargetRef.current ?? (recipeStarted ? "step" : "prompt");
      pttTargetRef.current = null;
      try {
        const response = await api.stopVoicePtt();
        const transcript = response.transcript?.trim();
        if (transcript) {
          applyTranscript(target, transcript);
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 400) {
          toast({
            title: "No se pudo capturar el audio",
            description: "Inténtalo nuevamente.",
            variant: "destructive",
          });
        } else {
          console.error("Voice PTT stop failed", error);
        }
      }
    },
    [applyTranscript, isListening, recipeStarted, toast]
  );

  const handlePointerDown = useCallback(
    (target: "prompt" | "step") => (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      void startVoiceCapture(target);
    },
    [startVoiceCapture]
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      void stopVoiceCapture();
    },
    [stopVoiceCapture]
  );

  const handlePointerCancel = useCallback(() => {
    void stopVoiceCapture();
  }, [stopVoiceCapture]);

  const handleKeyDown = useCallback(
    (target: "prompt" | "step") => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== " " && event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      void startVoiceCapture(target);
    },
    [startVoiceCapture]
  );

  const handleKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== " " && event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      void stopVoiceCapture();
    },
    [stopVoiceCapture]
  );

  useEffect(() => {
    return () => {
      void stopVoiceCapture();
    };
  }, [stopVoiceCapture]);

  const resetState = useCallback(() => {
    void stopVoiceCapture();
    setRecipe(null);
    setRecipeStarted(false);
    setRecipeCompleted(false);
    setCurrentStepIndex(0);
    setAssistantMessage(null);
    setStepResponses({});
    setUserPrompt("");
    lastSpokenStepRef.current = null;
    lastAssistantSpeechRef.current = null;
    previousStepRef.current = -1;
  }, [stopVoiceCapture]);

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

    if (availabilityLoading) {
      toast({
        title: "Comprobando asistente de recetas",
        description: "Espera un momento mientras se verifica la conexión con ChatGPT.",
      });
      return;
    }

    if (!recipesEnabled) {
      toast({
        title: "Asistente no disponible",
        description:
          availabilityReason ?? "Configura tu clave de OpenAI en Ajustes > Integraciones para habilitarlo.",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      lastSpokenStepRef.current = null;
      lastAssistantSpeechRef.current = null;
      previousStepRef.current = -1;
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
      setAssistantMessage(result.assistantMessage ?? result.step?.assistantMessage ?? null);

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

  const fallbackNavigate = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      navigate(-1);
      return;
    }

    navigate("/", { replace: true });
  }, [navigate]);

  const handleExit = useCallback(() => {
    resetState();

    if (onClose) {
      onClose();
      return;
    }

    fallbackNavigate();
  }, [fallbackNavigate, onClose, resetState]);

  const currentProgress = recipe ? Math.min(((currentStepIndex + 1) / recipe.steps.length) * 100, 100) : 0;

  useEffect(() => {
    if (!recipeStarted || !currentStep) {
      return;
    }
    if (previousStepRef.current === currentStep.index) {
      return;
    }
    previousStepRef.current = currentStep.index;
    lastAssistantSpeechRef.current = null;
    setAssistantMessage(currentStep.assistantMessage ?? currentStep.tip ?? null);
  }, [currentStep, recipeStarted]);

  useEffect(() => {
    if (!voiceEnabled || !recipeStarted || !recipe || !currentStep) {
      return;
    }
    const stepKey = `${recipe.id}-${currentStep.index}`;
    if (lastSpokenStepRef.current === stepKey) {
      return;
    }
    lastSpokenStepRef.current = stepKey;

    const pieces: string[] = [currentStep.instruction];
    if (currentStep.needsScale && typeof currentStep.expectedWeight === "number") {
      const weightText = formatWeight(currentStep.expectedWeight, decimals);
      if (weightText !== "–") {
        pieces.push(`Peso objetivo ${weightText} gramos`);
      }
    }
    if (currentStep.tip) {
      pieces.push(`Consejo: ${currentStep.tip}`);
    }

    const speech = pieces.filter(Boolean).join(". ");
    if (!speech) {
      return;
    }

    void api
      .speak(speech)
      .catch((error) => console.error("No se pudo reproducir la instrucción de receta", error));
  }, [voiceEnabled, recipeStarted, recipe, currentStep, decimals]);

  useEffect(() => {
    if (!voiceEnabled || !recipeStarted) {
      return;
    }
    if (typeof assistantMessage !== "string") {
      return;
    }
    const normalized = assistantMessage.trim();
    if (!normalized) {
      return;
    }

    const baseMessage = currentStep?.assistantMessage ?? currentStep?.tip ?? null;
    if (baseMessage && normalized === baseMessage.trim()) {
      return;
    }

    if (lastAssistantSpeechRef.current === normalized) {
      return;
    }
    lastAssistantSpeechRef.current = normalized;

    void api
      .speak(normalized)
      .catch((error) => console.error("No se pudo reproducir la respuesta del asistente", error));
  }, [assistantMessage, voiceEnabled, recipeStarted, currentStep?.assistantMessage, currentStep?.tip]);

  const navControls = navEnabled ? (
    <div className="flex items-center gap-2 p-4">
      <Button variant="outline" onClick={handleExit} className="gap-2">
        <ArrowLeft className="h-4 w-4" />
        Atrás
      </Button>
      {isModal && (
        <Button variant="ghost" onClick={handleExit} className="gap-2">
          <X className="h-4 w-4" />
          Cerrar
        </Button>
      )}
    </div>
  ) : null;

  let content: JSX.Element | null;

  if (!recipeStarted) {
    const startButtonContent = (() => {
      if (isLoading) {
        return "Generando...";
      }
      if (availabilityLoading) {
        return (
          <>
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Verificando...
          </>
        );
      }
      if (!recipesEnabled) {
        return "No disponible";
      }
      return (
        <>
          <ChefHat className="mr-2 h-6 w-6" /> Comenzar
        </>
      );
    })();

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
            {recipeModel && (
              <div className="mt-4 flex justify-center">
                <Badge variant="outline" className="px-3 py-1 text-sm font-medium">
                  Asistente IA: {recipeModel}
                </Badge>
              </div>
            )}
          </div>

          <div className="space-y-4">
            {!recipesEnabled && !availabilityLoading && (
              <Alert variant="destructive">
                <AlertTitle>Asistente de recetas no disponible</AlertTitle>
                <AlertDescription>
                  {availabilityReason ??
                    "Configura tu clave de OpenAI en Ajustes &gt; Integraciones para activar este modo."}
                </AlertDescription>
              </Alert>
            )}
            {availabilityLoading && (
              <Alert>
                <AlertTitle>Comprobando disponibilidad</AlertTitle>
                <AlertDescription>Estamos verificando la conexión con ChatGPT...</AlertDescription>
              </Alert>
            )}
            <Textarea
              placeholder={'Ejemplo: "Quiero preparar pasta con salsa de tomate"'}
              value={userPrompt}
              onChange={(event) => setUserPrompt(event.target.value)}
              className="min-h-32 text-lg"
              disabled={inputsDisabled}
            />

            <div className="grid grid-cols-2 gap-4">
              <Button
                onPointerDown={handlePointerDown("prompt")}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                onPointerLeave={() => {
                  if (isListening) {
                    void stopVoiceCapture();
                  }
                }}
                onKeyDown={handleKeyDown("prompt")}
                onKeyUp={handleKeyUp}
                variant={isListening ? "destructive" : "secondary"}
                size="xl"
                className="h-20 text-xl"
                disabled={!canUseRecipes}
              >
                {isListening ? (
                  <>
                    <MicOff className="mr-2 h-6 w-6" /> Suelta para enviar
                  </>
                ) : (
                  <>
                    <Mic className="mr-2 h-6 w-6" /> Mantén pulsado
                  </>
                )}
              </Button>

              <Button
                onClick={handleStart}
                disabled={isLoading || !canUseRecipes}
                variant="glow"
                size="xl"
                className="h-20 text-xl"
              >
                {startButtonContent}
              </Button>
            </div>
            {isListening && (
              <p className="text-sm text-muted-foreground text-center">Escuchando… suelta el botón para enviar.</p>
            )}
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
                {recipeModel && (
                  <Badge variant="outline" className="mt-2 text-xs font-medium">
                    IA: {recipeModel}
                  </Badge>
                )}
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
                        {ingredient.quantity !== null
                          ? `${formatWeight(ingredient.quantity, decimals)}${ingredient.unit}`
                          : ingredient.unit}
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
                  <p className="text-4xl font-bold">
                    {formatWeight(currentStep.expectedWeight, decimals)} g
                  </p>
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
                onPointerDown={handlePointerDown("step")}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                onPointerLeave={() => {
                  if (isListening) {
                    void stopVoiceCapture();
                  }
                }}
                onKeyDown={handleKeyDown("step")}
                onKeyUp={handleKeyUp}
                variant={isListening ? "destructive" : "outline"}
                className="flex-1"
              >
                {isListening ? (
                  <>
                    <MicOff className="mr-2 h-4 w-4" /> Suelta para enviar
                  </>
                ) : (
                  <>
                    <Mic className="mr-2 h-4 w-4" /> Mantén pulsado
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

            {isListening && (
              <p className="mt-2 text-sm text-muted-foreground">Escuchando… suelta el botón para registrar la respuesta.</p>
            )}

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
            onPointerDown={handlePointerDown("step")}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onPointerLeave={() => {
              if (isListening) {
                void stopVoiceCapture();
              }
            }}
            onKeyDown={handleKeyDown("step")}
            onKeyUp={handleKeyUp}
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
      <div className="absolute right-4 top-4 z-50 flex items-center">
        <Button
          variant="secondary"
          size="lg"
          onClick={handleExit}
          className="shadow-md"
        >
          <X className="mr-2 h-4 w-4" /> Salir
        </Button>
      </div>
      {content}
    </div>
  );
};
