/**
 * Test fixture backed by qsys-mock-core: startMockQrc is a thin wrapper over
 * startMockCore(TEST_DESIGN), the in-repo Q-SYS Core mock. Same wire format, same
 * test hooks (dropConnections / swallowNext / resetState / snapshot spies) — the
 * mock handle was built to cover them.
 *
 * Behaviours tests must respect (from the mock's control identity):
 *  - Controls have identity: type, range (clamped), units → rendered String/
 *    Position (e.g. -10 → "-10.0dB"), not String(value).
 *  - Sets apply immediately (the mock has no ramp interpolation).
 */
import { parseDesign, startMockCore, type MockCoreHandle } from 'qsys-mock-core';

export type MockHandle = MockCoreHandle;

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
  return startMockCore(parseDesign(TEST_DESIGN), {
    port,
    isEmulator: opts.isEmulator,
    tickMs: 25, // fast AutoPoll cadence so watch/reconnect tests settle quickly
  });
}
