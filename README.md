# Envim

<p align="center">
  <img src="assets/envim-icon.png" alt="Envim logo" width="160" height="160" />
</p>

Neovim frontend writen by electron.

## Requirements

- neovim (latest)
- nodejs

## Build

```sh
make linux   # Linux AppImage
make mac     # Intel Mac
make mac-arm # Apple Silicon Mac
make windows # Windows
```

The macOS and Windows targets produce unpacked apps under `release/`. If
`TARGET_FILE_NAME` is set, the build moves the app to that path.

## Concept

Envim is not editor, it only front end of neovim.
So, you must install neovim on your system, or run neovim as server.(e.g. docker)

## Feature

Support ui_ext below
- ext_multigrid
- ext_cmdline
- ext_tabline
- ext_popupmenu
- ext_messages
- ext_hlstate

## Screenshot

![Start Page](screenshot/Screenshot_from_2026-09-26_16-13-30.png)
![Editor window](screenshot/Screenshot_from_2026-09-26_16-19-20.png)
