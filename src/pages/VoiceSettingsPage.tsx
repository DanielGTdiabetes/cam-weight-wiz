import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VoiceTester } from "@/components/VoiceTester";
import { useNavigate } from "react-router-dom";

const VoiceSettingsPage = () => {
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={() => navigate(-1)}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Volver
        </Button>
        <h1 className="text-2xl font-bold">Pruebas de Voz</h1>
      </div>
      <VoiceTester />
    </div>
  );
};

export default VoiceSettingsPage;
