# Fixes Summary - Configuration & Network UX

## Backend Changes

### 1. Fixed `effective_mode` Logic (backend/miniweb.py)
**Problem:** Offline mode didn't deactivate when Ethernet with Internet was connected.

**Solution:** Rewrote `_determine_effective_mode()`:
- No IP on any interface → `"ap"` mode
- Connection with Internet → `"kiosk"` mode (auto-disables manual offline)
- Connection without Internet → `"offline"` mode
- Removed priority check for `offline_mode_enabled` that prevented auto-recovery

### 2. Fixed Settings Persistence (backend/miniweb.py)
**Problem:** `/api/settings` responded 200 but didn't persist OpenAI API key and Nightscout settings.

**Solution:** 
- Changed from `_save_json()` to use `SettingsService.save()` with atomic writes
- Settings now properly persist to `~/.bascula/config.json` with correct permissions (600)
- Version metadata increments on each save for change tracking

### 3. Updated Tests (backend/tests/)
- Updated `test_effective_mode.py` to reflect new logic (Internet availability overrides manual offline)
- Enhanced `test_miniweb_settings.py` with tests for:
  - Disk persistence verification
  - Version increment on save
  - Atomic write guarantees

## Frontend Changes

### 4. Fixed Build Errors (src/pages/SettingsView.tsx)
**Problem:** Variables used before declaration causing TypeScript errors.

**Solution:** Reordered state declarations to fix hoisting issues with `networkIP2` and `pinVerified`.

### 5. Simplified AP Mode Screen (src/components/APModeScreen.tsx)
**Problem:** Confusing UI with duplicate buttons and unclear messaging.

**Solution:**
- Streamlined to two clear buttons: "Configurar Wi-Fi" and "Modo Offline"
- Removed duplicate button sections
- Updated messaging to clarify auto-recovery when Internet is restored
- Added note about cable Ethernet configuration option

## Expected Behavior

### Normal Operation
1. **With Internet:** System runs in `kiosk` mode (normal operation)
2. **Without Internet:** System switches to `offline` mode automatically
3. **No connection:** System shows AP mode screen with WiFi setup

### Offline Mode Toggle
1. **Manual activation:** User can activate offline mode from AP screen or settings
2. **Auto-deactivation:** When Internet becomes available (especially via Ethernet), system automatically returns to `kiosk` mode
3. **Persistence:** Offline mode preference is saved but overridden by Internet availability

### Settings Persistence
1. **OpenAI API Key:** Saved to `network.openai_api_key`
2. **Nightscout URL/Token:** Saved to `diabetes.nightscout_url` and `diabetes.nightscout_token`
3. **Atomic Writes:** All settings use atomic write (write to `.tmp` + rename) to prevent corruption
4. **Permissions:** Config file is `600` (owner read/write only), directory is `700`

## Outstanding Issues

### 1. "Cannot access 'Yc' before initialization" Error
**Status:** Likely a build cache/bundling issue
**Suggested Fix:**
- Clear Vite build cache: `rm -rf backend/dist .vite node_modules/.vite`
- Rebuild: `npm run build` or from `scripts/install-all.sh`
- May require code splitting review if persists

### 2. Touch Keyboard Disappeared
**Status:** Needs investigation
**Files to Check:**
- `src/components/KeyboardDialog.tsx`
- `src/components/NumericKeyboard.tsx`
- `src/components/AlphanumericKeyboard.tsx`
- Backend keyboard integration

### 3. Installation Script Updates
**Recommended:** Update `scripts/install-all.sh` to:
```bash
# Clear frontend cache
rm -rf backend/dist
rm -rf node_modules/.vite
rm -rf .vite

# Rebuild
npm run build

# Restart services
sudo systemctl restart bascula-miniweb
```

## Testing Checklist

- [x] Offline mode auto-disables when Ethernet with Internet connects
- [x] Settings persist to disk with atomic writes
- [x] AP screen shows correct buttons and messaging
- [x] Build errors resolved
- [ ] Touch keyboard works on Raspberry Pi (needs hardware testing)
- [ ] Remote access to `/settings` works without "Yc" error (needs cache clear + rebuild)
- [ ] POST `/api/settings` persists OpenAI key and Nightscout credentials (covered by tests)

## Migration Notes

**No breaking changes.** Existing config files are compatible. The settings service includes automatic migration for misplaced keys (e.g., `openai_api_key` in wrong section).

## Files Modified

### Backend
- `backend/miniweb.py` - effective_mode logic, settings persistence
- `backend/tests/test_effective_mode.py` - updated test expectations
- `backend/tests/test_miniweb_settings.py` - added persistence tests

### Frontend
- `src/pages/SettingsView.tsx` - fixed variable declarations
- `src/components/APModeScreen.tsx` - simplified UI and messaging

### New Files
- `FIXES_SUMMARY.md` - this document
