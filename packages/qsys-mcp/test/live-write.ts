import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Live WRITE round-trip via the MCP server against a real target (emulator/Core):
 * find a Gain component, read its gain, set it, verify it changed, then restore.
 * Nothing persists unless the design is saved in Designer.
 *   npx tsx test/live-write.ts [host] [port]
 *
 * Safety: if the target is NOT an emulator this script refuses to run unless
 * QSYS_LIVE_WRITE_OK=1 is set — mutating a physical system requires a conspicuous
 * opt-in, not just pointing the script at an address.
 */
async function main(): Promise<void> {
  const host = process.argv[2] ?? '127.0.0.1';
  const port = Number(process.argv[3] ?? 1710);

  const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] });
  const client = new Client({ name: 'qsys-mcp-write', version: '0.0.0' });
  await client.connect(transport);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = (r?.content?.[0]?.text ?? '').toString();
    if (r?.isError) throw new Error(`${name} failed: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const conn = await call('qsys_connect', { host, port });
  if (conn?.status?.IsEmulator !== true) {
    if (process.env.QSYS_LIVE_WRITE_OK !== '1') {
      console.error(`REFUSING to write: ${host}:${port} is not an emulator (design "${conn?.status?.DesignName ?? 'unknown'}").`);
      console.error('This script mutates the running system. Re-run with QSYS_LIVE_WRITE_OK=1 to confirm.');
      await client.close();
      process.exit(1);
    }
    // Explicitly acknowledged: re-connect with the live-write capability.
    await call('qsys_connect', { host, port, allow_live_writes: true });
  }

  const comps: Array<{ Name: string; Type: string }> = await call('qsys_list_components');
  const gain = comps.find((c) => c.Type === 'gain');
  if (!gain) throw new Error('no gain component in this design to write to');
  console.log(`target component: ${gain.Name} [${gain.Type}]`);

  const ctrls: { Controls: Array<{ Name: string; Value: unknown }> } = await call('qsys_get_component_controls', { name: gain.Name });
  const gainCtrl = ctrls.Controls.find((c) => c.Name === 'gain') ?? ctrls.Controls.find((c) => /^gain/i.test(c.Name) && !/meter|peak|rms/i.test(c.Name));
  if (!gainCtrl) throw new Error(`no settable gain control on ${gain.Name}`);
  const ctrlName = gainCtrl.Name;
  const orig = Number(gainCtrl.Value);
  console.log(`control: ${ctrlName} | original value: ${orig}`);

  const target = orig === -12 ? -24 : -12;

  try {
    await call('qsys_set_component', { name: gain.Name, controls: [{ name: ctrlName, value: target }] });
    const after: { Controls: Array<{ Value: unknown }> } = await call('qsys_get_component', { name: gain.Name, controls: [ctrlName] });
    const read = Number(after.Controls[0].Value);
    console.log(`set -> ${target} | read back: ${read}`);
    if (Math.abs(read - target) > 0.6) throw new Error(`write not reflected: expected ~${target}, got ${read}`);
    if (read === orig) throw new Error('value did not change');
    console.log('WRITE CONFIRMED ✓');
  } finally {
    await call('qsys_set_component', { name: gain.Name, controls: [{ name: ctrlName, value: orig }] });
    const restored: { Controls: Array<{ Value: unknown }> } = await call('qsys_get_component', { name: gain.Name, controls: [ctrlName] });
    console.log(`restored -> ${Number(restored.Controls[0].Value)} (original ${orig})`);
  }

  await client.close();
  console.log('LIVE WRITE OK');
}

main().catch((e) => {
  console.error('LIVE WRITE FAIL:', e);
  process.exit(1);
});
