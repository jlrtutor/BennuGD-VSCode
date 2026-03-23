# BennuGD2 for VSCode 2026

VS Code extension by **LazySoftware.es** for **BennuGD2** development, with compatibility helpers for BennuGD v1.

- Repository: <https://github.com/jlrtutor/BennuGD-VSCode>
- Website: <https://lazysoftware.es>
- Presentation page: <https://github.com/jlrtutor/BennuGD-VSCode/blob/master/docs/index.html>

## What This Extension Includes

- BennuGD2 syntax highlighting (`.prg` defaults to BennuGD2)
- BennuGD v1 syntax support
- LSP features from Bennu source trees:
  - hover
  - completion
  - go to definition
  - diagnostics
- Compile command
- Compile and run command
- Path configuration panel with Browse buttons

## Quick Start Flow

1. Install the extension in VS Code.
2. Open your Bennu project.
3. Run `BennuGD: Configure Paths...`.
4. Set:
   - `Source root`
   - `Compiler path` (`bgdc` or its folder)
   - `Runtime path` (`bgdi` or its folder)
5. Save paths.
6. Compile with shortcut:
   - `Ctrl+Alt+B` (Windows/Linux)
   - `Cmd+Alt+B` (macOS)
7. Compile and run with shortcut:
   - `Ctrl+Alt+R` (Windows/Linux)
   - `Cmd+Alt+R` (macOS)

## Full Installation and Usage (Step by Step)

1. Clone the extension repository:

```bash
git clone https://github.com/jlrtutor/BennuGD-VSCode.git
cd BennuGD-VSCode
```

2. Build and package the extension:

```bash
npm install
npm run compile
npx @vscode/vsce package
```

3. Install the generated VSIX in VS Code:
   - Open VS Code.
   - Open `Extensions`.
   - Click the `...` menu (top-right in Extensions view).
   - Click `Install from VSIX...`.
   - Select the generated file inside the cloned folder:
     - `bennugd-vscode-support-1.0.43.vsix`

4. Configure Bennu paths:
   - Open `Settings`.
   - Search `BennuGD`.
   - Run `BennuGD: Configure Paths...` from command palette.
   - Set:
     - `Source root`
     - `Compiler path`
     - `Runtime path`
   - Select BennuGD binary folders (or exact `bgdc`/`bgdi` binaries).

5. Open your BennuGD project in VS Code.

6. Run compile and run:
   - Open command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
   - Execute `BennuGD: Compile and Run Current File`.
   - Shortcut:
     - `Ctrl+Alt+R` (Windows/Linux)
     - `Cmd+Alt+R` (macOS)

## Commands

- `BennuGD: Compile Current File`
- `BennuGD: Compile and Run Current File`
- `BennuGD: Configure Paths...`
- `BennuGD: Open Settings`
- `BennuGD v1: Compile Current File`
- `BennuGD v1: Compile and Run Current File`
- `BennuGD v1: Configure Paths...`
- `BennuGD v2: Compile Current File`
- `BennuGD v2: Compile and Run Current File`
- `BennuGD v2: Configure Paths...`

## Recommended Paths (macOS Apple Silicon)

Apple Silicon binaries can be found in your BennuGD2 repository:

- <https://github.com/jlrtutor/BennuGD2>

```json
{
  "bennugd.defaultVersion": "v2",
  "bennugd.v2.sourceRoot": "<BENNUGD2_ROOT>",
  "bennugd.v2.compilerPath": "<BENNUGD2_ROOT>/build/macos-arm64/bin/bgdc",
  "bennugd.v2.runtimePath": "<BENNUGD2_ROOT>/build/macos-arm64/bin/bgdi"
}
```

## Development / Packaging

```bash
npm install
npm run compile
npx @vscode/vsce package
```

Then install the generated `.vsix` from VS Code.

## Help: npm Not Installed

If you get `npm: command not found` or similar, install Node.js (npm is included).

### Check if Node.js and npm are installed

```bash
node -v
npm -v
```

### macOS

Option A (official installer):

- Download and install Node.js LTS from <https://nodejs.org/en/download>

Option B (Homebrew):

```bash
brew install node
```

### Windows

Option A (official installer):

- Download and install Node.js LTS from <https://nodejs.org/en/download>

Option B (winget):

```powershell
winget install OpenJS.NodeJS.LTS
```

### Linux

Option A (NodeSource setup): check latest instructions at:

- <https://github.com/nodesource/distributions>

Option B (distro packages):

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y nodejs npm
```

Fedora:

```bash
sudo dnf install -y nodejs npm
```

Arch:

```bash
sudo pacman -S nodejs npm
```

After installing, close and reopen your terminal, then run:

```bash
node -v
npm -v
```

## Notes

- This extension does not bundle Bennu binaries.
- If `compilerPath` or `runtimePath` points to a folder, the extension automatically looks for `bgdc` / `bgdi` inside it.
- If a path is empty, the extension attempts project-tree auto-detection and then falls back to `PATH`.

## Credits and Thanks

- Thanks to **Rufidj**, author of the existing BennuGD2 VS Code extension, for the prior work and references that helped this project.
- Thanks to **SplinterGU** and the **BennuGD/BennuGD2 contributors** for the engine and ecosystem.

## Logo and Branding Note

The extension icon is based on BennuGD visual material as a tribute/reference to the official project identity.

---

Created by **LazySoftware.es**  
Website: <https://lazysoftware.es>  
Repository: <https://github.com/jlrtutor/BennuGD-VSCode>
