import { useState, useEffect } from "react";
import { Camera, Timer, Utensils, TrendingUp } from "lucide-react";
import { WeightDisplay } from "@/components/WeightDisplay";
import { ActionCard } from "@/components/ActionCard";
import { Header } from "@/components/Header";

interface HomeProps {
  onNavigate: (view: string) => void;
}

export const Home = ({ onNavigate }: HomeProps) => {
  const [weight, setWeight] = useState(0);
  const [isStable, setIsStable] = useState(false);

  // Simulate weight updates
  useEffect(() => {
    const interval = setInterval(() => {
      const random = Math.random();
      const newWeight = 120 + (random * 10) - 5;
      setWeight(newWeight);
      setIsStable(random > 0.5);
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header 
        title="Báscula Inteligente" 
        subtitle="Sistema de nutrición y diabetes"
      />
      
      <main className="mx-auto max-w-screen-xl space-y-6 p-4">
        {/* Weight Display */}
        <WeightDisplay weight={weight} isStable={isStable} />

        {/* Quick Actions */}
        <div>
          <h2 className="mb-4 text-lg font-semibold">Acciones Rápidas</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ActionCard
              icon={Camera}
              title="Escanear Alimento"
              description="Usa la cámara para identificar y analizar alimentos"
              variant="primary"
              onClick={() => onNavigate("scanner")}
            />
            <ActionCard
              icon={Timer}
              title="Temporizador"
              description="Configura y controla temporizadores de cocina"
              variant="secondary"
              onClick={() => onNavigate("timer")}
            />
            <ActionCard
              icon={Utensils}
              title="Recetas"
              description="Explora y gestiona tus recetas favoritas"
              onClick={() => onNavigate("recipes")}
            />
            <ActionCard
              icon={TrendingUp}
              title="Historial"
              description="Revisa tus mediciones y progreso"
              onClick={() => {}}
            />
          </div>
        </div>

        {/* Recent Activity */}
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-semibold">Actividad Reciente</h2>
          <div className="space-y-3">
            {[
              { food: "Manzana", weight: "150g", time: "Hace 2 horas" },
              { food: "Pan integral", weight: "80g", time: "Hace 5 horas" },
              { food: "Pollo", weight: "200g", time: "Ayer" },
            ].map((item, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-lg bg-muted/30 p-3 transition-smooth hover:bg-muted/50"
              >
                <div>
                  <p className="font-medium">{item.food}</p>
                  <p className="text-sm text-muted-foreground">{item.time}</p>
                </div>
                <span className="text-lg font-semibold text-primary">
                  {item.weight}
                </span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
};
