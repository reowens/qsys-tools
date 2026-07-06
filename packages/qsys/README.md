# qsys-cli

Control a running Q-SYS Core from the shell, over QSC's QRC protocol —
works against real Core hardware and against **Q-SYS Designer in Emulate
mode** (validated on a live Designer emulation). The human/scriptable
sibling of [`q-sys-mcp`](https://www.npmjs.com/package/q-sys-mcp), built on
the same [`qsys-qrc`](https://www.npmjs.com/package/qsys-qrc) client
(keepalive + transparent auto-reconnect included).

## Install

```sh
npm install -g qsys-cli   # installs the `qsys` command
npx qsys-cli status       # or one-shot, no install
```

(The npm package is `qsys-cli` — npm reserves the bare name `qsys` — but the
installed command is plain `qsys`.)

## Usage

```sh
export QSYS_HOST=192.168.1.10          # or pass --host on every call

qsys status                            # engine/design status
qsys ls --type gain                    # list components, filtered by type
qsys get MainGain                      # read a named control
qsys set MainGain -6 --ramp 2          # set it (negative values just work)
qsys get-component Gain1               # all controls of a component
qsys set-component Gain1 mute true
qsys watch MainGain --interval 0.2     # stream changes until Ctrl-C
qsys snapshot load Bank 1 --ramp 1
```

Every command takes `--json` for machine-readable output (`watch` emits JSON lines).
Connection: `--host/--port/--user/--password` or `QSYS_HOST/QSYS_PORT/QSYS_USER/QSYS_PASSWORD`.

Values coerce naturally: `true`/`false` → boolean, numeric → number, anything else → string.

## Notes

- QRC has no way to enumerate named controls or snapshot banks — you need to
  know their names from the design (`ls` lists components that have script
  access enabled).
- `watch` uses QRC change groups; momentary trigger controls don't emit
  change events (they never hold a value).

## Disclaimer

This is an independent open-source project, **not affiliated with, endorsed
by, or supported by QSC, LLC**. "Q-SYS" is a trademark of QSC. The CLI
speaks the publicly documented QRC protocol and contains no QSC code.

## License

MIT
