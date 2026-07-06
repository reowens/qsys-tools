/**
 * Test fixture riding the real emulator engine (Phase 4 of qsys-emulator):
 * startMockQrc is a thin wrapper over startEmulator(TEST_DESIGN), so the mock
 * and the emulator can never drift apart. Same wire format, same test hooks
 * (dropConnections / swallowNext / resetState / spies) — the emulator handle
 * was built to cover them.
 *
 * Differences from the old hand-rolled mock that tests must respect:
 *  - Controls have identity: type, range (clamped), units → rendered String/
 *    Position (e.g. -10 → "-10.0dB"), not String(value).
 *  - Ramped sets interpolate on the emulator tick; the target lands after
 *    ~ramp seconds instead of immediately.
 */
import { parseDesign, startEmulator, type EmulatorHandle } from 'qsys-emulator';

export type MockHandle = EmulatorHandle;

/** The old mock's hardcoded fixture, now as a design literal (same names/values). */
const TEST_DESIGN = {
  design: { name: 'MockDesign', code: 'mock', platform: 'MockEmulator' },
  namedControls: [
    { name: 'MainGain', type: 'gain', min: -100, max: 20, units: 'dB', value: -10 },
    { name: 'MainMute', type: 'mute' },
  ],
  components: [
    { name: 'Gain1', type: 'gain', controls: [
      { name: 'gain', type: 'gain', min: -100, max: 20, units: 'dB', value: -6 },
      { name: 'mute', type: 'mute' },
    ] },
    { name: 'Mixer1', type: 'mixer', controls: [] },
    { name: 'Gain2', type: 'gain', controls: [] },
  ],
};

export function startMockQrc(port = 0, opts: { isEmulator?: boolean } = {}): Promise<MockHandle> {
  return startEmulator(parseDesign(TEST_DESIGN), {
    port,
    isEmulator: opts.isEmulator,
    tickMs: 25, // fast ramp ticks so ramped-set tests settle quickly
  });
}
