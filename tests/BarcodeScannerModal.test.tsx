import type { ComponentProps } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: toastMock,
  }),
}));

let mockScaleState = {
  weight: 150,
  isStable: true,
  unit: 'g' as const,
  isConnected: true,
  error: null as string | null,
  reconnectAttempts: 0,
};

vi.mock('@/hooks/useScaleWebSocket', () => ({
  useScaleWebSocket: () => mockScaleState,
}));

const storageMocks = vi.hoisted(() => ({
  getScannerHistory: vi.fn<[], any[]>(),
  addScannerRecord: vi.fn(),
  getSettings: vi.fn<[], any>(),
  enqueueScannerAction: vi.fn(),
  dequeueScannerAction: vi.fn<[], any>(),
  clearScannerQueue: vi.fn(),
  saveScannerHistory: vi.fn(),
}));

vi.mock('@/services/storage', () => ({
  storage: storageMocks,
}));

const apiMocks = vi.hoisted(() => ({
  scanBarcode: vi.fn<[_: string], Promise<any>>(),
  analyzeFoodPhoto: vi.fn<[_: string], Promise<any>>(),
  exportBolus: vi.fn<[_: number, _: number, _: string], Promise<void>>(),
}));

vi.mock('@/services/api', () => ({
  api: apiMocks,
}));

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/services/logger', () => ({
  logger: loggerMocks,
}));

let barcodeSuccess: (code: string) => void = () => {};
let barcodeError: (error: unknown) => void = () => {};
const html5RenderMock = vi.hoisted(() => vi.fn());
const html5ClearMock = vi.hoisted(() => vi.fn(async () => undefined));
const html5ConstructorMock = vi.hoisted(() =>
  vi.fn(() => ({
    render: html5RenderMock,
    clear: html5ClearMock,
  }))
);

vi.mock('html5-qrcode', () => ({
  Html5QrcodeScanner: html5ConstructorMock,
}));

describe('BarcodeScannerModal', () => {
  const baseSettings = {
    calibrationFactor: 1,
    defaultUnit: 'g',
    chatGptKey: '',
    apiUrl: '',
    wsUrl: '',
    nightscoutUrl: '',
    nightscoutToken: '',
    diabetesMode: false,
    correctionFactor: 0,
    carbRatio: 0,
    targetGlucose: 0,
    hypoAlarm: 0,
    hyperAlarm: 0,
    isVoiceActive: false,
    theme: 'dark',
  } as const;

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    toastMock.mockClear();

    mockScaleState = {
      weight: 150,
      isStable: true,
      unit: 'g',
      isConnected: true,
      error: null,
      reconnectAttempts: 0,
    };

    storageMocks.getScannerHistory.mockReturnValue([]);
    storageMocks.addScannerRecord.mockReset();
    storageMocks.enqueueScannerAction.mockReset();
    storageMocks.dequeueScannerAction.mockReset();
    storageMocks.getSettings.mockReturnValue({ ...baseSettings });

    apiMocks.scanBarcode.mockReset();
    apiMocks.analyzeFoodPhoto.mockReset();
    apiMocks.exportBolus.mockReset();

    barcodeSuccess = () => {};
    barcodeError = () => {};
    html5RenderMock.mockClear();
    html5RenderMock.mockImplementation((success, error) => {
      barcodeSuccess = success;
      barcodeError = error;
    });
    html5ClearMock.mockClear();
    html5ConstructorMock.mockClear();

    Object.defineProperty(navigator, 'onLine', {
      value: true,
      configurable: true,
    });

    const getUserMedia = navigator.mediaDevices?.getUserMedia as unknown as vi.Mock;
    if (getUserMedia) {
      getUserMedia.mockResolvedValue({
        getTracks: () => [
          {
            stop: vi.fn(),
          },
        ],
      });
    }
  });

  const renderModal = (props?: Partial<ComponentProps<typeof BarcodeScannerModal>>) => {
    const onClose = vi.fn();
    const onFoodConfirmed = vi.fn();

    const result = render(
      <BarcodeScannerModal
        open
        onClose={onClose}
        onFoodConfirmed={onFoodConfirmed}
        {...props}
      />
    );

    return { ...result, onClose, onFoodConfirmed };
  };

  it('procesa un código de barras exitosamente y confirma el alimento online', async () => {
    const queueAction = {
      type: 'exportBolus' as const,
      carbs: 12,
      insulin: 0,
      timestamp: '2024-01-01T00:00:00.000Z',
    };
    storageMocks.dequeueScannerAction
      .mockReturnValueOnce(queueAction)
      .mockReturnValueOnce(null);

    storageMocks.getSettings.mockReturnValue({
      ...baseSettings,
      nightscoutUrl: 'https://nightscout.test',
      nightscoutToken: 'token',
    });

    apiMocks.scanBarcode.mockResolvedValue({
      name: 'Manzana Gala',
      nutrition: {
        carbs: 15,
        proteins: 2,
        fats: 1,
      },
      confidence: 0.9,
    });

    apiMocks.exportBolus.mockResolvedValue();

    const user = userEvent.setup();
    const { onClose, onFoodConfirmed } = renderModal();

    await waitFor(() =>
      expect(apiMocks.exportBolus).toHaveBeenCalledWith(12, 0, '2024-01-01T00:00:00.000Z')
    );

    expect(screen.getAllByText('Selecciona un modo de escaneo para comenzar').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /código de barras/i }));

    await waitFor(() => expect(html5ConstructorMock).toHaveBeenCalled());
    expect(await screen.findByText(/apunta la cámara al código de barras/i)).toBeInTheDocument();

    await act(async () => {
      barcodeSuccess('7501035194805');
    });

    await waitFor(() => expect(apiMocks.scanBarcode).toHaveBeenCalledWith('7501035194805'));

    const nameInput = await screen.findByLabelText(/nombre del alimento/i);
    expect(nameInput).toHaveValue('Manzana Gala');
    expect(screen.getByText('Código de barras')).toBeInTheDocument();
    expect(screen.getByText('Confianza 90%')).toBeInTheDocument();

    const perHundredCard = screen.getByRole('heading', { name: /por 100 g/i }).closest('div');
    expect(perHundredCard).toBeTruthy();
    expect(within(perHundredCard as HTMLElement).getByText('15 g')).toBeInTheDocument();

    const continueButton = screen.getByRole('button', { name: /continuar a pesar/i });
    await waitFor(() => expect(continueButton).toBeEnabled());
    await user.click(continueButton);

    expect(await screen.findByText('150 g')).toBeInTheDocument();
    const nutritionSummary = screen.getByRole('heading', { name: /nutrición estimada/i }).closest('div');
    expect(nutritionSummary).toBeTruthy();
    expect(
      within(nutritionSummary as HTMLElement).getByText((content) => content.includes('22.5 g'))
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /confirmar/i }));

    await waitFor(() => expect(apiMocks.exportBolus).toHaveBeenCalledTimes(2));
    const confirmExportCall = apiMocks.exportBolus.mock.calls.at(-1);
    expect(confirmExportCall?.[0]).toBe(22.5);
    expect(confirmExportCall?.[1]).toBe(0);
    expect(typeof confirmExportCall?.[2]).toBe('string');

    expect(storageMocks.addScannerRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Manzana Gala',
        carbsPer100g: 15,
        source: 'barcode',
        confidence: 0.9,
        timestamp: expect.any(String),
      })
    );

    expect(onFoodConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Manzana Gala',
        weight: 150,
        carbs: 22.5,
        kcal: 116,
      })
    );

    expect(onFoodConfirmed.mock.calls[0][0].timestamp).toBeInstanceOf(Date);
    expect(onClose).toHaveBeenCalled();
    expect(navigator.vibrate).toHaveBeenCalledWith(200);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Alimento registrado' })
    );
  });

  it('cambia a fallback manual cuando el código no existe y encola exportación offline', async () => {
    apiMocks.scanBarcode.mockRejectedValue(new Error('not found'));
    storageMocks.getScannerHistory.mockReturnValueOnce([]);
    storageMocks.getSettings.mockReturnValue({
      ...baseSettings,
      nightscoutUrl: 'https://nightscout.test',
      nightscoutToken: 'token',
    });

    mockScaleState = {
      ...mockScaleState,
      weight: 200,
    };

    Object.defineProperty(navigator, 'onLine', {
      value: false,
      configurable: true,
    });

    const user = userEvent.setup();
    const { onFoodConfirmed } = renderModal();

    await user.click(screen.getByRole('button', { name: /código de barras/i }));

    await waitFor(() => expect(html5ConstructorMock).toHaveBeenCalled());

    await act(async () => {
      barcodeSuccess('000000');
    });

    const manualTab = await screen.findByRole('tab', { name: /manual/i });
    await user.click(manualTab);

    const nameInput = screen.getByLabelText(/nombre del alimento/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'a');

    await waitFor(() =>
      expect(screen.getByText('Ingresa al menos 2 caracteres')).toBeInTheDocument()
    );

    await user.clear(nameInput);
    await user.type(nameInput, 'Granola casera');

    const carbsInput = screen.getByLabelText(/carbos/i);
    await user.clear(carbsInput);
    await user.type(carbsInput, '30');

    const kcalInput = screen.getByLabelText(/kcal/i);
    await user.clear(kcalInput);
    await user.type(kcalInput, '120');

    const proteinsInput = screen.getByLabelText(/proteínas/i);
    await user.clear(proteinsInput);
    await user.type(proteinsInput, '5');

    const fatsInput = screen.getByLabelText(/grasas/i);
    await user.clear(fatsInput);
    await user.type(fatsInput, '4');

    const saveButton = screen.getByRole('button', { name: /guardar y pesar/i });
    await waitFor(() => expect(saveButton).toBeEnabled());

    await user.click(saveButton);

    expect(await screen.findByText('200 g')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /confirmar/i }));

    await waitFor(() => expect(storageMocks.addScannerRecord).toHaveBeenCalled());
    expect(apiMocks.exportBolus).not.toHaveBeenCalled();
    expect(storageMocks.enqueueScannerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'exportBolus',
        carbs: 60,
        insulin: 0,
        timestamp: expect.any(String),
      })
    );
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Sin conexión' })
    );

    expect(onFoodConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Granola casera',
        weight: 200,
        carbs: 60,
        kcal: 240,
      })
    );
  });

  it('analiza una foto con IA y muestra la vista previa con confianza', async () => {
    apiMocks.analyzeFoodPhoto.mockResolvedValue({
      name: 'Ensalada mixta',
      carbsPer100g: 10,
      proteinsPer100g: 2,
      fatsPer100g: 1,
      kcalPer100g: 80,
      confidence: 0.95,
    });

    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: /foto ia/i }));

    await waitFor(() =>
      expect(navigator.mediaDevices.getUserMedia as unknown as vi.Mock).toHaveBeenCalled()
    );

    expect(await screen.findByText(/apunta al alimento y espera/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /capturar ahora/i }));

    await waitFor(() => expect(apiMocks.analyzeFoodPhoto).toHaveBeenCalled());

    const nameInput = await screen.findByLabelText(/nombre del alimento/i);
    expect(nameInput).toHaveValue('Ensalada mixta');
    expect(screen.getByText('IA')).toBeInTheDocument();
    expect(screen.getByText('Confianza 95%')).toBeInTheDocument();

    const weightInput = screen.getByLabelText(/peso de la porción/i);
    await user.clear(weightInput);
    await user.type(weightInput, '150');

    const totalCard = screen.getByRole('heading', { name: /porción total/i }).closest('div');
    await waitFor(() =>
      expect(
        within(totalCard as HTMLElement).getByText((content) => content.trim() === '15 g')
      ).toBeInTheDocument()
    );

    const perTotalButton = screen.getByRole('button', { name: /por total/i });
    await user.click(perTotalButton);

    const carbsInput = screen.getByLabelText(/carbohidratos/i);
    await waitFor(() => expect(carbsInput).toHaveValue(15));

    await user.clear(carbsInput);
    await user.type(carbsInput, '18');

    const perHundredButton = screen.getByRole('button', { name: /por 100 g/i });
    await user.click(perHundredButton);
    await waitFor(() => expect(carbsInput).toHaveValue(12));
    await waitFor(() =>
      expect(
        within(totalCard as HTMLElement).getByText((content) => content.trim() === '18 g')
      ).toBeInTheDocument()
    );

    const continueButton = screen.getByRole('button', { name: /continuar a pesar/i });
    await waitFor(() => expect(continueButton).toBeDisabled());

    const confirmCheckbox = screen.getByRole('checkbox', { name: /confirma carbs estimados/i });
    await user.click(confirmCheckbox);
    await waitFor(() => expect(continueButton).toBeEnabled());
  });

  it('vuelve al escaneo de código de barras cuando la IA no detecta el alimento', async () => {
    const COOLDOWN_MS = 20_000;
    let currentTime = Date.now();
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    apiMocks.analyzeFoodPhoto.mockResolvedValue(null);

    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: /foto ia/i }));

    currentTime += COOLDOWN_MS + 1000;

    expect(await screen.findByText(/apunta al alimento y espera/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /capturar ahora/i }));

    await waitFor(() => expect(apiMocks.analyzeFoodPhoto).toHaveBeenCalled());
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Detección IA incierta, probando barcode' })
    );
    await waitFor(() => expect(html5ConstructorMock).toHaveBeenCalled());

    expect(await screen.findByText(/apunta la cámara al código de barras/i)).toBeInTheDocument();

    dateSpy.mockRestore();
  });

  it('cambia a código de barras cuando la confianza de la IA es baja', async () => {
    const COOLDOWN_MS = 20_000;
    let currentTime = Date.now();
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    apiMocks.analyzeFoodPhoto.mockResolvedValue({
      name: 'Yogur natural',
      carbsPer100g: 5,
      proteinsPer100g: 4,
      fatsPer100g: 3,
      confidence: 0.6,
    });

    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: /foto ia/i }));

    currentTime += COOLDOWN_MS + 1000;

    expect(await screen.findByText(/apunta al alimento y espera/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /capturar ahora/i }));

    await waitFor(() => expect(apiMocks.analyzeFoodPhoto).toHaveBeenCalled());
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Detección IA incierta, probando barcode' })
    );
    await waitFor(() => expect(html5ConstructorMock).toHaveBeenCalled());

    expect(await screen.findByText(/apunta la cámara al código de barras/i)).toBeInTheDocument();

    dateSpy.mockRestore();
  });

  it('muestra la entrada por voz cuando expira el temporizador de la IA', async () => {
    vi.useFakeTimers();
    let resolveAnalysis: ((value: unknown) => void) | undefined;
    apiMocks.analyzeFoodPhoto.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAnalysis = resolve;
        })
    );

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderModal();

    await user.click(screen.getByRole('button', { name: /foto ia/i }));

    await waitFor(() =>
      expect(navigator.mediaDevices.getUserMedia as unknown as vi.Mock).toHaveBeenCalled()
    );

    expect(await screen.findByText(/apunta al alimento y espera/i)).toBeInTheDocument();

    vi.advanceTimersByTime(10_000);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Tiempo agotado' }))
    );

    expect(await screen.findByText(/dicta el alimento y sus datos/i)).toBeInTheDocument();

    await waitFor(() => expect(apiMocks.analyzeFoodPhoto).toHaveBeenCalled());

    await act(async () => {
      resolveAnalysis?.(null);
    });
  });
});
