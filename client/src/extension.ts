import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

type BennuVersion = 'v1' | 'v2';
type PathField = 'sourceRoot' | 'compilerPath' | 'runtimePath';

interface VersionSettings {
  sourceRoot: string;
  compilerPath: string;
  runtimePath: string;
  compilerArgs: string[];
  runtimeArgs: string[];
}

let client: LanguageClient | undefined;
let versionSyncTimer: NodeJS.Timeout | undefined;
const outputChannel = vscode.window.createOutputChannel('BennuGD');
let versionStatusBarItem: vscode.StatusBarItem | undefined;
let pathsPanel: vscode.WebviewPanel | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

function cfg() {
  return vscode.workspace.getConfiguration('bennugd');
}

function defaultVersion(): BennuVersion {
  return cfg().get<BennuVersion>('defaultVersion', 'v2');
}

function versionSettings(version: BennuVersion): VersionSettings {
  const prefix = version === 'v1' ? 'v1' : 'v2';
  return {
    sourceRoot: cfg().get<string>(`${prefix}.sourceRoot`, ''),
    compilerPath: cfg().get<string>(`${prefix}.compilerPath`, ''),
    runtimePath: cfg().get<string>(`${prefix}.runtimePath`, ''),
    compilerArgs: cfg().get<string[]>(`${prefix}.compilerArgs`, []),
    runtimeArgs: cfg().get<string[]>(`${prefix}.runtimeArgs`, []),
  };
}

function languageVersion(document?: vscode.TextDocument): BennuVersion {
  if (document?.languageId === 'bennugd2') {
    return 'v2';
  }
  if (document?.languageId === 'bennugd') {
    return 'v1';
  }
  return defaultVersion();
}

function currentVersion(document?: vscode.TextDocument): BennuVersion {
  return languageVersion(document);
}

function workspaceRoot(document?: vscode.TextDocument): string {
  const folder = document ? vscode.workspace.getWorkspaceFolder(document.uri) : vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath ?? '';
}

function resolveSettingPath(value: string, fallback: string, document?: vscode.TextDocument): string {
  if (value.trim()) {
    if (path.isAbsolute(value)) {
      return value;
    }
    return path.resolve(workspaceRoot(document) || process.cwd(), value);
  }
  return fallback;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function declarationLineForSymbol(text: string, symbol: string): { line: number; character: number } | undefined {
  const escaped = escapeRegExp(symbol);
  const declarationPattern = new RegExp(
    `^\\s*(?:(?:private|public|global|local)\\s+)?(?:process|function|procedure)\\b[^\\n;]*\\b${escaped}\\b`,
    'i',
  );
  const lines = text.split(/\r?\n/);
  const lowerSymbol = symbol.toLowerCase();
  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i];
    if (!declarationPattern.test(lineText)) {
      continue;
    }
    const character = Math.max(lineText.toLowerCase().indexOf(lowerSymbol), 0);
    return { line: i, character };
  }
  return undefined;
}

function makeLocation(uri: vscode.Uri, line: number, character: number, symbolLength: number): vscode.Location {
  return new vscode.Location(
    uri,
    new vscode.Range(
      new vscode.Position(Math.max(line, 0), Math.max(character, 0)),
      new vscode.Position(Math.max(line, 0), Math.max(character, 0) + Math.max(symbolLength, 1)),
    ),
  );
}

async function findDefinitionFallback(
  document: vscode.TextDocument,
  symbol: string,
): Promise<vscode.Location | undefined> {
  const localDefinition = declarationLineForSymbol(document.getText(), symbol);
  if (localDefinition) {
    return makeLocation(document.uri, localDefinition.line, localDefinition.character, symbol.length);
  }

  for (const openDocument of vscode.workspace.textDocuments) {
    if (openDocument.uri.toString() === document.uri.toString()) {
      continue;
    }
    if (openDocument.languageId !== 'bennugd' && openDocument.languageId !== 'bennugd2') {
      continue;
    }
    const definition = declarationLineForSymbol(openDocument.getText(), symbol);
    if (definition) {
      return makeLocation(openDocument.uri, definition.line, definition.character, symbol.length);
    }
  }

  const files = await vscode.workspace.findFiles('**/*.{prg,inc}', '**/{.git,node_modules,dist,out,build}/**', 3000);
  for (const file of files) {
    if (file.toString() === document.uri.toString()) {
      continue;
    }
    try {
      const data = await vscode.workspace.fs.readFile(file);
      const text = Buffer.from(data).toString('utf8');
      const definition = declarationLineForSymbol(text, symbol);
      if (definition) {
        return makeLocation(file, definition.line, definition.character, symbol.length);
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function executableExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveConfiguredBinary(value: string, binary: 'bgdc' | 'bgdi', document?: vscode.TextDocument): string {
  const resolved = resolveSettingPath(value, binary, document);
  if (!resolved.trim()) {
    return binary;
  }

  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const directoryCandidate = path.join(resolved, binary);
      if (executableExists(directoryCandidate)) {
        return directoryCandidate;
      }
      return directoryCandidate;
    }
  } catch {
    // fall through to return the resolved path as-is
  }

  return resolved;
}

function parentDirectories(startPath: string): string[] {
  const result: string[] = [];
  let current = path.resolve(startPath);
  while (true) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return result;
}

function resolveBennuBinary(
  version: BennuVersion,
  settings: VersionSettings,
  document: vscode.TextDocument | undefined,
  binary: 'bgdc' | 'bgdi',
): string {
  const explicitPath = binary === 'bgdc' ? settings.compilerPath : settings.runtimePath;
  if (explicitPath.trim()) {
    return resolveConfiguredBinary(explicitPath, binary, document);
  }

  const fallbackRoot = workspaceRoot(document) || process.cwd();
  const seedRoots = [
    resolveSettingPath(settings.sourceRoot, '', document),
    document ? path.dirname(document.uri.fsPath) : '',
    fallbackRoot,
  ].filter((value) => value.trim().length > 0);

  const relativeCandidates =
    process.platform === 'win32'
      ? [
          ['build', 'bin', `${binary}.exe`],
          ['binaries', 'win32', 'bin', `${binary}.exe`],
          ['core', `${binary}.exe`],
        ]
      : process.platform === 'darwin'
        ? [
            ['build', 'macos-arm64', 'bin', binary],
            ['binaries', 'macos-arm64', 'bin', binary],
            ['build', 'bin', binary],
            ['build', 'core', binary],
            ['core', binary],
          ]
        : [
            ['build', 'linux-gnu', 'bin', binary],
            ['binaries', 'linux-gnu', 'bin', binary],
            ['build', 'bin', binary],
            ['build', 'core', binary],
            ['core', binary],
          ];

  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const seedRoot of seedRoots) {
    for (const ancestor of parentDirectories(seedRoot)) {
      for (const rel of relativeCandidates) {
        const candidate = path.join(ancestor, ...rel);
        if (!seen.has(candidate)) {
          seen.add(candidate);
          candidates.push(candidate);
        }
      }
    }
  }

  candidates.push(binary);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (executableExists(candidate)) {
        return candidate;
      }
    } else {
      return candidate;
    }
  }

  return binary;
}

function quote(part: string): string {
  if (process.platform === 'win32') {
    return `"${part.replace(/"/g, '""')}"`;
  }
  return `'${part.replace(/'/g, `'"'"'`)}'`;
}

function spawnLogged(
  executable: string,
  args: string[],
  cwd: string,
  title: string,
): Promise<number> {
  return new Promise((resolve) => {
    outputChannel.show(true);
    outputChannel.appendLine(`[${title}] ${[executable, ...args].map(quote).join(' ')}`);
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => outputChannel.append(chunk.toString()));
    child.stderr.on('data', (chunk) => outputChannel.append(chunk.toString()));
    child.on('error', (error) => {
      outputChannel.appendLine(String(error));
      resolve(-1);
    });
    child.on('close', (code) => {
      outputChannel.appendLine(`[${title}] exit code ${code ?? -1}`);
      resolve(code ?? -1);
    });
  });
}

async function compile(document: vscode.TextDocument, version: BennuVersion): Promise<string | undefined> {
  if (document.isDirty) {
    await document.save();
  }

  if (!document.uri.fsPath || path.extname(document.uri.fsPath).toLowerCase() !== '.prg') {
    vscode.window.showErrorMessage('Open a BennuGD .prg file to compile.');
    return undefined;
  }

  const settings = versionSettings(version);
  const cwd = path.dirname(document.uri.fsPath);
  const compiler = resolveBennuBinary(version, settings, document, 'bgdc');
  const sourceRoot = resolveSettingPath(settings.sourceRoot, cwd, document);
  const args = ['-i', sourceRoot, ...settings.compilerArgs, path.basename(document.uri.fsPath)];

  if (path.isAbsolute(compiler) && !executableExists(compiler)) {
    vscode.window.showErrorMessage(`BennuGD ${version} compiler not found: ${compiler}`);
    return undefined;
  }

  const code = await spawnLogged(compiler, args, cwd, `BennuGD ${version} compile`);
  if (code !== 0) {
    return undefined;
  }

  return path.join(cwd, `${path.parse(document.uri.fsPath).name}.dcb`);
}

async function run(document: vscode.TextDocument, version: BennuVersion): Promise<void> {
  const settings = versionSettings(version);
  const runtime = resolveBennuBinary(version, settings, document, 'bgdi');

  let dcbPath: string | undefined;
  if (document.uri.fsPath.toLowerCase().endsWith('.dcb')) {
    dcbPath = document.uri.fsPath;
  } else {
    dcbPath = await compile(document, version);
  }
  if (!dcbPath) {
    return;
  }

  const cwd = path.dirname(dcbPath);
  const runtimeArgs = [...settings.runtimeArgs, path.basename(dcbPath)];
  if (path.isAbsolute(runtime) && !executableExists(runtime)) {
    vscode.window.showErrorMessage(`BennuGD ${version} runtime not found: ${runtime}`);
    return;
  }
  await spawnLogged(runtime, runtimeArgs, cwd, `BennuGD ${version} run`);
}

function createClient(context: vscode.ExtensionContext): LanguageClient {
  const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));
  const settings = cfg();
  const v1Settings = versionSettings('v1');
  const v2Settings = versionSettings('v2');
  const sharedSourceRoots = settings.get<string[]>('lsp.sourceRoots', []).filter((value) => value.trim().length > 0);
  const v1SourceRoots = [v1Settings.sourceRoot].filter((value) => value.trim().length > 0);
  const v2SourceRoots = [v2Settings.sourceRoot].filter((value) => value.trim().length > 0);

  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        env: {
          ...process.env,
        },
      },
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        env: {
          ...process.env,
        },
      },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'bennugd' },
      { scheme: 'file', language: 'bennugd2' },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{prg,inc,bgd,bgn,_exports.h,c}'),
    },
    initializationOptions: {
      defaultVersion: defaultVersion(),
      sourceRoots: sharedSourceRoots,
      compilerPath: settings.get<string>('lsp.compilerPath', ''),
      v1SourceRoots,
      v2SourceRoots,
      v1CompilerPath: v1Settings.compilerPath,
      v2CompilerPath: v2Settings.compilerPath,
    },
    outputChannel,
  };

  return new LanguageClient('bennugdLanguageServer', 'BennuGD Language Server', serverOptions, clientOptions);
}

async function syncDocumentVersion(document?: vscode.TextDocument) {
  if (!client || !document) {
    return;
  }
  client.sendNotification('bennugd/documentVersion', {
    uri: document.uri.toString(),
    version: languageVersion(document),
  });
}

async function syncAllVisibleDocuments() {
  for (const editor of vscode.window.visibleTextEditors) {
    await syncDocumentVersion(editor.document);
  }
}

function updateVersionStatusBar(document?: vscode.TextDocument) {
  if (!versionStatusBarItem) {
    return;
  }

  const version = languageVersion(document);
  versionStatusBarItem.text = `BennuGD ${version}`;
  versionStatusBarItem.tooltip = `Active Bennu language mode: BennuGD ${version}`;
  versionStatusBarItem.show();
}

async function restartClient(context: vscode.ExtensionContext) {
  if (client) {
    await client.stop();
    client = undefined;
  }
  client = createClient(context);
  await client.start();
}

function registerCommand(context: vscode.ExtensionContext, command: string, handler: () => Promise<void> | void) {
  context.subscriptions.push(vscode.commands.registerCommand(command, handler));
}

function openSettings(query: string) {
  return vscode.commands.executeCommand('workbench.action.openSettings', query);
}

function configurationTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

function webviewNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return nonce;
}

function dialogRoot(currentValue: string): vscode.Uri {
  const candidate = currentValue.trim();
  const fallback = workspaceRoot() || process.cwd();
  const absolute = candidate ? (path.isAbsolute(candidate) ? candidate : path.resolve(fallback, candidate)) : fallback;
  try {
    const stat = fs.statSync(absolute);
    return vscode.Uri.file(stat.isDirectory() ? absolute : path.dirname(absolute));
  } catch {
    return vscode.Uri.file(path.dirname(absolute));
  }
}

async function updatePathSetting(version: BennuVersion, key: keyof VersionSettings, value: string) {
  await cfg().update(`${version}.${key}`, value, configurationTarget());
}

async function pickVersionPath(
  version: BennuVersion,
  field: PathField,
): Promise<string | undefined> {
  const label = version === 'v1' ? 'BennuGD v1' : 'BennuGD v2';
  const settings = versionSettings(version);
  const currentValue = settings[field];

  if (field === 'sourceRoot') {
    const picked = await vscode.window.showOpenDialog({
      title: `${label}: Select source root`,
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: dialogRoot(currentValue),
    });
    return picked?.[0]?.fsPath;
  }

  const picked = await vscode.window.showOpenDialog({
    title: `${label}: Select ${field === 'compilerPath' ? 'compiler' : 'runtime'} binary or folder`,
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: dialogRoot(currentValue),
  });
  return picked?.[0]?.fsPath;
}

async function saveVersionSettings(version: BennuVersion, settings: VersionSettings) {
  await cfg().update(`${version}.sourceRoot`, settings.sourceRoot, configurationTarget());
  await cfg().update(`${version}.compilerPath`, settings.compilerPath, configurationTarget());
  await cfg().update(`${version}.runtimePath`, settings.runtimePath, configurationTarget());
}

function versionHelp(version: BennuVersion): string {
  const label = version === 'v1' ? 'BennuGD v1' : 'BennuGD v2';
  return [
    `${label} source root: the Bennu source tree used for LSP indexing and for locating binaries automatically.`,
    `${label} compiler path: the bgdc executable or the folder that contains it.`,
    `${label} runtime path: the bgdi executable or the folder that contains it.`,
  ].join('\n\n');
}

function createPathsWebviewHtml(webview: vscode.Webview, version: BennuVersion): string {
  const nonce = webviewNonce();
  const v1 = versionSettings('v1');
  const v2 = versionSettings('v2');
  const state = {
    version,
    versions: { v1, v2 },
    help: { v1: versionHelp('v1'), v2: versionHelp('v2') },
  };

  return /* html */ `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        :root {
          color-scheme: dark;
          --bg: var(--vscode-editor-background);
          --panel: var(--vscode-sideBar-background);
          --text: var(--vscode-foreground);
          --muted: var(--vscode-descriptionForeground);
          --border: var(--vscode-widget-border);
          --button: var(--vscode-button-background);
          --button-text: var(--vscode-button-foreground);
        }
        body {
          margin: 0;
          padding: 28px;
          background: linear-gradient(180deg, color-mix(in srgb, var(--bg) 96%, white 4%), var(--bg));
          color: var(--text);
          font-family: var(--vscode-font-family);
        }
        h1 {
          margin: 0 0 8px 0;
          font-size: 28px;
          letter-spacing: -0.02em;
        }
        p {
          margin: 0;
          color: var(--muted);
          line-height: 1.55;
        }
        .top {
          display: grid;
          gap: 12px;
          margin-bottom: 20px;
        }
        .toolbar {
          display: flex;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
        }
        .toolbar label {
          display: inline-flex;
          gap: 10px;
          align-items: center;
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 10px 14px;
        }
        select, input {
          font: inherit;
        }
        select {
          background: transparent;
          border: none;
          color: var(--text);
        }
        .card {
          background: color-mix(in srgb, var(--panel) 92%, transparent);
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 18px;
        }
        .field {
          display: grid;
          gap: 8px;
          margin-bottom: 16px;
        }
        .field:last-child {
          margin-bottom: 0;
        }
        .field-header {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: baseline;
        }
        .field-header h2 {
          margin: 0;
          font-size: 16px;
        }
        .field-header .hint {
          color: var(--muted);
          font-size: 12px;
        }
        .input-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 10px;
          align-items: center;
        }
        input {
          width: 100%;
          box-sizing: border-box;
          background: var(--bg);
          color: var(--text);
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 10px 12px;
        }
        button {
          border: none;
          border-radius: 10px;
          padding: 10px 14px;
          font: inherit;
          cursor: pointer;
        }
        .secondary {
          background: transparent;
          color: var(--text);
          border: 1px solid var(--border);
        }
        .primary {
          background: var(--button);
          color: var(--button-text);
        }
        .help {
          white-space: pre-wrap;
          color: var(--muted);
          line-height: 1.55;
          margin-top: 12px;
        }
        .actions {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          margin-top: 18px;
        }
      </style>
    </head>
    <body>
      <div class="top">
        <h1>BennuGD path configuration</h1>
        <p>
          Use this screen to clearly assign each path. The source root is your Bennu tree, the compiler is
          <code>bgdc</code>, and the runtime is <code>bgdi</code>. For compiler and runtime you can choose either
          the folder that contains the binary or the binary itself.
        </p>
        <div class="toolbar">
          <label>
            <span>Version</span>
            <select id="version">
              <option value="v1">BennuGD v1</option>
              <option value="v2">BennuGD v2</option>
            </select>
          </label>
          <button class="secondary" type="button" id="openSettings">Open Settings</button>
        </div>
      </div>

      <div class="card">
        <div class="field">
          <div class="field-header">
            <h2>Source root</h2>
            <span class="hint">Bennu tree root for LSP indexing and discovery</span>
          </div>
          <div class="input-row">
            <input id="sourceRoot" type="text" placeholder="/path/to/BennuGD" />
            <button class="secondary" type="button" data-field="sourceRoot">Browse...</button>
          </div>
        </div>

        <div class="field">
          <div class="field-header">
            <h2>Compiler path</h2>
            <span class="hint">bgdc executable or the folder that contains it</span>
          </div>
          <div class="input-row">
            <input id="compilerPath" type="text" placeholder="/path/to/bgdc or folder" />
            <button class="secondary" type="button" data-field="compilerPath">Browse...</button>
          </div>
        </div>

        <div class="field">
          <div class="field-header">
            <h2>Runtime path</h2>
            <span class="hint">bgdi executable or the folder that contains it</span>
          </div>
          <div class="input-row">
            <input id="runtimePath" type="text" placeholder="/path/to/bgdi or folder" />
            <button class="secondary" type="button" data-field="runtimePath">Browse...</button>
          </div>
        </div>

        <div class="help" id="help"></div>
        <div class="actions">
          <button class="secondary" type="button" id="close">Close</button>
          <button class="primary" type="button" id="save">Save Paths</button>
        </div>
      </div>

      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const state = ${JSON.stringify(state)};
        const versionSelect = document.getElementById('version');
        const sourceRoot = document.getElementById('sourceRoot');
        const compilerPath = document.getElementById('compilerPath');
        const runtimePath = document.getElementById('runtimePath');
        const help = document.getElementById('help');

        [sourceRoot, compilerPath, runtimePath].forEach((input) => {
          input.addEventListener('input', () => {
            const field = input.id;
            state.versions[versionSelect.value][field] = input.value;
          });
        });

        function populate() {
          const current = state.versions[versionSelect.value];
          sourceRoot.value = current.sourceRoot || '';
          compilerPath.value = current.compilerPath || '';
          runtimePath.value = current.runtimePath || '';
          help.textContent = state.help[versionSelect.value];
        }

        function currentFieldValue(field) {
          if (field === 'sourceRoot') return sourceRoot.value;
          if (field === 'compilerPath') return compilerPath.value;
          return runtimePath.value;
        }

        versionSelect.addEventListener('change', () => {
          vscode.postMessage({ type: 'switchVersion', version: versionSelect.value });
          populate();
        });

        document.querySelectorAll('[data-field]').forEach((button) => {
          button.addEventListener('click', () => {
            const field = button.getAttribute('data-field');
            if (!field) {
              return;
            }
            vscode.postMessage({
              type: 'browse',
              version: versionSelect.value,
              field,
              value: currentFieldValue(field),
            });
          });
        });

        document.getElementById('openSettings').addEventListener('click', () => {
          vscode.postMessage({ type: 'openSettings' });
        });

        document.getElementById('close').addEventListener('click', () => {
          vscode.postMessage({ type: 'close' });
        });

        document.getElementById('save').addEventListener('click', () => {
          vscode.postMessage({
            type: 'save',
            version: versionSelect.value,
            sourceRoot: sourceRoot.value,
            compilerPath: compilerPath.value,
            runtimePath: runtimePath.value,
          });
        });

        window.addEventListener('message', (event) => {
          const message = event.data;
          if (message.type === 'setPath') {
            const field = document.getElementById(message.field);
            if (field) {
              field.value = message.value || '';
            }
            if (message.version && state.versions[message.version]) {
              state.versions[message.version][message.field] = message.value || '';
            }
          }
          if (message.type === 'setState') {
            state.versions[message.version] = message.settings;
            if (versionSelect.value === message.version) {
              populate();
            }
          }
          if (message.type === 'setVersion') {
            versionSelect.value = message.version;
            populate();
          }
        });

        populate();
      </script>
    </body>
    </html>
  `;
}

async function openPathsPanel(context: vscode.ExtensionContext, version: BennuVersion) {
  if (pathsPanel) {
    pathsPanel.dispose();
  }

  pathsPanel = vscode.window.createWebviewPanel(
    'bennugdPaths',
    'BennuGD Paths',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  pathsPanel.onDidDispose(() => {
    pathsPanel = undefined;
  });

  pathsPanel.webview.onDidReceiveMessage(async (message) => {
    if (!pathsPanel) {
      return;
    }

    if (message.type === 'close') {
      pathsPanel.dispose();
      return;
    }

    if (message.type === 'openSettings') {
      await openSettings('BennuGD');
      return;
    }

    if (message.type === 'browse') {
      outputChannel.appendLine(`[paths] browse requested: version=${message.version} field=${message.field}`);
      const picked = await pickVersionPath(message.version as BennuVersion, message.field as PathField);
      outputChannel.appendLine(`[paths] browse result: ${picked ?? 'cancelled'}`);
      if (picked !== undefined) {
        await pathsPanel.webview.postMessage({
          type: 'setPath',
          version: message.version,
          field: message.field,
          value: picked,
        });
      }
      return;
    }

    if (message.type === 'save') {
      const versionKey = message.version as BennuVersion;
      await saveVersionSettings(versionKey, {
        sourceRoot: String(message.sourceRoot ?? ''),
        compilerPath: String(message.compilerPath ?? ''),
        runtimePath: String(message.runtimePath ?? ''),
        compilerArgs: versionSettings(versionKey).compilerArgs,
        runtimeArgs: versionSettings(versionKey).runtimeArgs,
      });
      await restartClient(context);
      updateVersionStatusBar(vscode.window.activeTextEditor?.document);
      vscode.window.showInformationMessage(`BennuGD ${versionKey} paths updated.`);
      return;
    }

    if (message.type === 'switchVersion') {
      await pathsPanel.webview.postMessage({
        type: 'setState',
        version: message.version,
        settings: versionSettings(message.version as BennuVersion),
      });
    }
  });

  pathsPanel.webview.html = createPathsWebviewHtml(pathsPanel.webview, version);
  pathsPanel.webview.postMessage({
    type: 'setVersion',
    version,
  });
}

async function configurePathsWizard(version?: BennuVersion) {
  const chosenVersion = version ?? defaultVersion();
  if (!extensionContext) {
    return;
  }
  await openPathsPanel(extensionContext, chosenVersion);
}

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  client = createClient(context);
  await client.start();
  await syncAllVisibleDocuments();

  versionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(versionStatusBarItem);
  updateVersionStatusBar(vscode.window.activeTextEditor?.document);

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    [
      { scheme: 'file', language: 'bennugd' },
      { scheme: 'file', language: 'bennugd2' },
    ],
    {
      provideDefinition: async (document, position) => {
        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_#][A-Za-z0-9_#]*/);
        if (!wordRange) {
          return undefined;
        }
        const symbol = document.getText(wordRange);
        if (!symbol) {
          return undefined;
        }
        return findDefinitionFallback(document, symbol);
      },
    },
  ));

  registerCommand(context, 'bennugd.compileCurrentFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await compile(editor.document, currentVersion(editor.document));
  });

  registerCommand(context, 'bennugd.runCurrentFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await run(editor.document, currentVersion(editor.document));
  });

  registerCommand(context, 'bennugd.compileAndRunCurrentFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await run(editor.document, currentVersion(editor.document));
  });

  registerCommand(context, 'bennugd.compileCurrentFileV1', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await compile(editor.document, 'v1');
  });

  registerCommand(context, 'bennugd.runCurrentFileV1', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await run(editor.document, 'v1');
  });

  registerCommand(context, 'bennugd.compileAndRunCurrentFileV1', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await run(editor.document, 'v1');
  });

  registerCommand(context, 'bennugd.compileCurrentFileV2', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await compile(editor.document, 'v2');
  });

  registerCommand(context, 'bennugd.runCurrentFileV2', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await run(editor.document, 'v2');
  });

  registerCommand(context, 'bennugd.compileAndRunCurrentFileV2', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await run(editor.document, 'v2');
  });

  registerCommand(context, 'bennugd.configurePaths', async () => {
    await configurePathsWizard();
  });

  registerCommand(context, 'bennugd.configurePathsV1', async () => {
    await configurePathsWizard('v1');
  });

  registerCommand(context, 'bennugd.configurePathsV2', async () => {
    await configurePathsWizard('v2');
  });

  registerCommand(context, 'bennugd.openSettings', async () => {
    await openSettings('BennuGD');
  });

  registerCommand(context, 'bennugd.openSettingsV1', async () => {
    await openSettings('bennugd.v1');
  });

  registerCommand(context, 'bennugd.openSettingsV2', async () => {
    await openSettings('bennugd.v2');
  });

  registerCommand(context, 'bennugd2.compile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await compile(editor.document, 'v2');
  });

  registerCommand(context, 'bennugd2.run', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await run(editor.document, 'v2');
  });

  registerCommand(context, 'bennugd2.compileAndRun', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await run(editor.document, 'v2');
  });

  registerCommand(context, 'bennugd1.compile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await compile(editor.document, 'v1');
  });

  registerCommand(context, 'bennugd1.run', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await run(editor.document, 'v1');
  });

  registerCommand(context, 'bennugd1.compileAndRun', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await run(editor.document, 'v1');
  });

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => {
    void syncDocumentVersion(document);
  }));

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
    void syncDocumentVersion(editor?.document);
    updateVersionStatusBar(editor?.document);
  }));

  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors((editors) => {
    for (const editor of editors) {
      void syncDocumentVersion(editor.document);
    }
    updateVersionStatusBar(vscode.window.activeTextEditor?.document);
  }));

  versionSyncTimer = setInterval(() => {
    void syncAllVisibleDocuments();
    updateVersionStatusBar(vscode.window.activeTextEditor?.document);
  }, 1500);
  context.subscriptions.push({ dispose: () => {
    if (versionSyncTimer) {
      clearInterval(versionSyncTimer);
      versionSyncTimer = undefined;
    }
  } });

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (event.affectsConfiguration('bennugd')) {
      await restartClient(context);
      updateVersionStatusBar(vscode.window.activeTextEditor?.document);
    }
  }));
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
  if (versionSyncTimer) {
    clearInterval(versionSyncTimer);
    versionSyncTimer = undefined;
  }
  versionStatusBarItem?.dispose();
  versionStatusBarItem = undefined;
  outputChannel.dispose();
}
