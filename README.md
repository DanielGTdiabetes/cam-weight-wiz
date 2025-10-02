# Welcome to your Lovable project

## Project info

**URL**: https://lovable.dev/projects/315129b0-b47e-4e39-a2bd-640990fb32ef

## How can I edit this code?

There are several ways of editing your application.

**Use Lovable**

Simply visit the [Lovable Project](https://lovable.dev/projects/315129b0-b47e-4e39-a2bd-640990fb32ef) and start prompting.

Changes made via Lovable will be committed automatically to this repo.

**Use your preferred IDE**

If you want to work locally using your own IDE, you can clone this repo and push changes. Pushed changes will also be reflected in Lovable.

The only requirement is having Node.js & npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)

Follow these steps:

```sh
# Step 1: Clone the repository using the project's Git URL.
git clone <YOUR_GIT_URL>

# Step 2: Navigate to the project directory.
cd <YOUR_PROJECT_NAME>

# Step 3: Install the necessary dependencies.
npm i

# Step 4: Start the development server with auto-reloading and an instant preview.
npm run dev
```

**Edit a file directly in GitHub**

- Navigate to the desired file(s).
- Click the "Edit" button (pencil icon) at the top right of the file view.
- Make your changes and commit the changes.

**Use GitHub Codespaces**

- Navigate to the main page of your repository.
- Click on the "Code" button (green button) near the top right.
- Select the "Codespaces" tab.
- Click on "New codespace" to launch a new Codespace environment.
- Edit files directly within the Codespace and commit and push your changes once you're done.

## What technologies are used for this project?

This project is built with:

- Vite
- TypeScript
- React
- shadcn-ui
- Tailwind CSS

## How can I deploy this project?

Simply open [Lovable](https://lovable.dev/projects/315129b0-b47e-4e39-a2bd-640990fb32ef) and click on Share -> Publish.

## Can I connect a custom domain to my Lovable project?

Yes, you can!

To connect a domain, navigate to Project > Settings > Domains and click Connect Domain.

Read more here: [Setting up a custom domain](https://docs.lovable.dev/features/custom-domain#custom-domain)

## Mini-Web (AP setup)

Pruebas de aceptación rápidas (backend servido en `http://localhost:8080`):

```bash
# Healthcheck
curl -s http://localhost:8080/health

# SPA principal (debe devolver HTML, no una página en blanco)
curl -s http://localhost:8080/ | head

# Leer PIN (solo visible en modo AP, bandera o cabecera forzada)
curl -s http://localhost:8080/api/miniweb/pin

# Verificar PIN persistente
curl -s -X POST http://localhost:8080/api/miniweb/verify-pin \
  -H 'Content-Type: application/json' \
  -d '{"pin":"NNNN"}'

# Escanear redes Wi-Fi (403 si falta permiso, 503 si no hay nmcli)
curl -s http://localhost:8080/api/miniweb/scan-networks

# Iniciar conexión Wi-Fi (ejemplo)
curl -s -X POST http://localhost:8080/api/miniweb/connect-wifi \
  -H 'Content-Type: application/json' \
  -d '{"ssid":"MiRed","password":"secreto"}'

# Estado de red actual
curl -s http://localhost:8080/api/network/status
```

Expectativas clave:

- `/api/miniweb/pin` → `200` solo en modo AP (`wlan0` = `192.168.4.1/24`), bandera `BASCULA_ALLOW_PIN_READ=1` o cabecera `X-Force-Pin: 1` desde `127.0.0.1`; en STA responde `403`.
- El PIN permanece tras reinicios gracias a `/var/lib/bascula/miniweb_state.json`.
- `POST /api/miniweb/verify-pin` permite 10 intentos por IP cada 10 minutos (luego `429`).
- `GET /api/miniweb/scan-networks` funciona sin `sudo`; si PolicyKit no está aplicado devuelve `403 {"code":"NMCLI_NOT_AUTHORIZED"}`.
- `POST /api/miniweb/connect-wifi` conecta con NetworkManager, desactiva el AP y programa un reinicio.
