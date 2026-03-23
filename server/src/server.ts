import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  CompletionItemKind,
  Diagnostic,
  DiagnosticSeverity,
  DocumentSymbol,
  Hover,
  InitializeParams,
  ParameterInformation,
  ProposedFeatures,
  Location,
  SignatureHelp,
  SignatureInformation,
  SymbolKind,
  TextDocuments,
  TextDocumentSyncKind,
  createConnection,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

interface InitializationOptions {
  defaultVersion?: 'v1' | 'v2';
  sourceRoots?: string[];
  compilerPath?: string;
  v1SourceRoots?: string[];
  v2SourceRoots?: string[];
  v1CompilerPath?: string;
  v2CompilerPath?: string;
}

interface SymbolEntry {
  key: string;
  name: string;
  kind: 'function' | 'constant';
  signature: string;
  signatures: string[];
  returnType: string;
  module: string;
  source: string;
  description: string;
  variants: string[];
  definitionUri?: string;
  definitionLine?: number;
}

interface DefinitionEntry {
  description: string;
  definitionUri: string;
  definitionLine: number;
}

interface UserFunctionEntry {
  key: string;
  name: string;
  arities: number[];
  signatures: string[];
  parameterNames: string[][];
  parameterTypes: (string | undefined)[][];
  description: string;
  definitionUri: string;
  definitionLine: number;
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

type BennuVersion = 'v1' | 'v2';

let initializationOptions: InitializationOptions = {};
let defaultVersion: BennuVersion = 'v2';
let sharedSourceRoots: string[] = [];
let sourceRootsByVersion: Record<BennuVersion, string[]> = { v1: [], v2: [] };
let compilerPathByVersion: Record<BennuVersion, string> = { v1: '', v2: '' };
let symbolIndexByVersion: Record<BennuVersion, Map<string, SymbolEntry>> = { v1: new Map(), v2: new Map() };
let userFunctionIndexByVersion: Record<BennuVersion, Map<string, UserFunctionEntry>> = { v1: new Map(), v2: new Map() };
const openDocuments = new Map<string, string>();
const documentVersions = new Map<string, BennuVersion>();

const TYPE_MAP: Record<string, string> = {
  TYPE_INT: 'int',
  TYPE_QWORD: 'qword',
  TYPE_DWORD: 'dword',
  TYPE_WORD: 'word',
  TYPE_SHORT: 'short',
  TYPE_BYTE: 'byte',
  TYPE_DOUBLE: 'double',
  TYPE_FLOAT: 'float',
  TYPE_STRING: 'string',
  TYPE_POINTER: 'pointer',
  TYPE_UNDEFINED: 'void',
};

const PARAM_MAP: Record<string, string[]> = {
  '': [],
  I: ['int'],
  D: ['double'],
  S: ['string'],
  P: ['pointer'],
  Q: ['qword'],
  V: ['variant'],
  B: ['byte'],
  F: ['float'],
  W: ['word'],
};

const NUMERIC_TYPES = new Set(['int', 'double', 'float', 'qword', 'dword', 'word', 'short', 'byte']);
const KNOWN_PARAM_TYPES = new Set(['int', 'double', 'float', 'qword', 'dword', 'word', 'short', 'byte', 'string', 'pointer', 'variant']);

const BENNUGD_KEYWORDS = [
  'begin',
  'break',
  'case',
  'else',
  'end',
  'for',
  'frame',
  'global',
  'if',
  'local',
  'loop',
  'process',
  'private',
  'public',
  'return',
  'while',
  'wstich',
];

function uriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    return fileURLToPath(uri);
  }
  return uri;
}

function pathToUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function versionFromLanguageId(languageId?: string | null, fallback: BennuVersion = defaultVersion): BennuVersion {
  if (languageId === 'bennugd2') {
    return 'v2';
  }
  if (languageId === 'bennugd') {
    return 'v1';
  }
  return fallback;
}

function getDocumentVersion(uri: string): BennuVersion {
  return documentVersions.get(uri) ?? defaultVersion;
}

function getIndex(version: BennuVersion): Map<string, SymbolEntry> {
  return symbolIndexByVersion[version];
}

function walk(dir: string, predicate: (fullPath: string) => boolean): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walk(fullPath, predicate));
    } else if (predicate(fullPath)) {
      result.push(fullPath);
    }
  }
  return result;
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, Math.max(index, 0)).split(/\r?\n/).length - 1;
}

function collectDescription(block: string): string {
  const lines: string[] = [];
  let capture = false;
  for (const raw of block.split(/\r?\n/)) {
    let line = raw.trim();
    line = line.replace(/^\/\*+/, '').replace(/\*+\/$/, '').trim();
    if (!line) {
      continue;
    }
    if (line.startsWith('FUNCTION :')) {
      continue;
    }
    if (line.startsWith('PARAMS:') || line.startsWith('RETURN VALUE:')) {
      break;
    }
    if (line.startsWith('DESCRIPTION:')) {
      capture = true;
      line = line.split('DESCRIPTION:', 2)[1].trim();
    } else if (!capture) {
      continue;
    }
    if (line) {
      lines.push(line);
    }
  }
  return lines.join(' ').trim();
}

function addSymbol(
  root: string,
  moduleName: string,
  filePath: string,
  line: string,
  lineNumber: number,
  descriptions: Record<string, DefinitionEntry>,
  bucket: Map<string, SymbolEntry>,
) {
  const func = line.match(/FUNC\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*TYPE_([A-Z_]+)\s*,\s*([A-Za-z0-9_]+)\s*\)/);
  if (func) {
    const [, name, signature, rawType, source] = func;
    const key = name.toUpperCase();
    const returnType = TYPE_MAP[`TYPE_${rawType}`] ?? rawType.toLowerCase();
    const existing = bucket.get(key);
    const variant = `${name}(${signature}) -> ${returnType} [${path.basename(root)}:${moduleName}]`;
    if (!existing) {
      const description = descriptions[source];
      bucket.set(key, {
        key,
        name,
        kind: 'function',
        signature,
        signatures: [signature],
        returnType,
        module: moduleName,
        source,
        description: description?.description ?? '',
        variants: [],
        definitionUri: description?.definitionUri,
        definitionLine: description?.definitionLine,
      });
    } else {
      existing.variants.push(variant);
      if (!existing.signatures.includes(signature)) {
        existing.signatures.push(signature);
      }
      const description = descriptions[source];
      if (description && !existing.definitionUri) {
        existing.definitionUri = description.definitionUri;
        existing.definitionLine = description.definitionLine;
      }
    }
    return;
  }

  const constant = line.match(/\{\s*"([^"]+)"\s*,\s*TYPE_([A-Z_]+)\s*,/);
  if (constant) {
    const [, name, rawType] = constant;
    const key = name.toUpperCase();
    if (!bucket.has(key)) {
      bucket.set(key, {
        key,
        name,
        kind: 'constant',
        signature: '',
        signatures: [],
        returnType: TYPE_MAP[`TYPE_${rawType}`] ?? rawType.toLowerCase(),
        module: moduleName,
        source: '',
        description: '',
        variants: [],
        definitionUri: pathToUri(filePath),
        definitionLine: lineNumber,
      });
    }
  }
}

function scanRoot(root: string, bucket: Map<string, SymbolEntry>) {
  const descriptions: Record<string, DefinitionEntry> = {};
  for (const filePath of walk(root, (fullPath) => fullPath.endsWith('.c'))) {
    let text = '';
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const blockMatch of text.matchAll(/\/\*[\s\S]*?\*\//g)) {
      const block = blockMatch[0];
      const blockIndex = blockMatch.index ?? 0;
      const match = block.match(/FUNCTION\s*:\s*([A-Za-z0-9_#]+)/);
      if (!match) {
        continue;
      }
      descriptions[match[1]] = {
        description: collectDescription(block),
        definitionUri: pathToUri(filePath),
        definitionLine: lineNumberAt(text, blockIndex),
      };
    }
  }

  for (const header of walk(root, (fullPath) => fullPath.endsWith('_exports.h'))) {
    const moduleName = path.basename(path.dirname(header));
    let text = '';
    try {
      text = fs.readFileSync(header, 'utf8');
    } catch {
      continue;
    }
    for (const [lineNumber, line] of text.split(/\r?\n/).entries()) {
      addSymbol(root, moduleName, header, line, lineNumber, descriptions, bucket);
    }
  }
}

function stripDeclarationComments(line: string): string {
  let output = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1] ?? '';
    if (inString) {
      if (ch === quote && line[i - 1] !== '\\') {
        inString = false;
      }
      output += ch;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      inString = true;
      quote = ch;
      output += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      return output;
    }
    output += ch;
  }
  return output;
}

function countDeclarationParams(paramsText?: string): number {
  const text = (paramsText ?? '').trim();
  if (!text) {
    return 0;
  }
  return splitArguments(text).length;
}

function parseUserParams(paramsText?: string): { names: string[]; types: (string | undefined)[] } {
  const text = (paramsText ?? '').trim();
  if (!text) {
    return { names: [], types: [] };
  }
  const parts = splitArguments(text).map((part) => part.trim()).filter((part) => part.length > 0);
  const names: string[] = [];
  const types: (string | undefined)[] = [];

  for (const part of parts) {
    const normalized = part.replace(/&/g, ' ').trim();
    const tokens = normalized.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) {
      continue;
    }
    const maybeType = tokens[0].toLowerCase();
    if (tokens.length >= 2 && KNOWN_PARAM_TYPES.has(maybeType)) {
      types.push(maybeType);
      names.push(tokens.slice(1).join(' '));
      continue;
    }
    types.push(undefined);
    names.push(tokens.join(' '));
  }

  return { names, types };
}

function addUserFunction(
  bucket: Map<string, UserFunctionEntry>,
  filePath: string,
  lineNumber: number,
  name: string,
  description: string,
  paramsText?: string,
) {
  const key = name.toUpperCase();
  const arity = countDeclarationParams(paramsText);
  const parsedParams = parseUserParams(paramsText);
  const signature = `${name}(${(paramsText ?? '').trim()})`;
  const existing = bucket.get(key);
  if (!existing) {
    bucket.set(key, {
      key,
      name,
      arities: [arity],
      signatures: [signature],
      parameterNames: [parsedParams.names],
      parameterTypes: [parsedParams.types],
      description,
      definitionUri: pathToUri(filePath),
      definitionLine: lineNumber,
    });
    return;
  }
  if (!existing.arities.includes(arity)) {
    existing.arities.push(arity);
  }
  if (!existing.signatures.includes(signature)) {
    existing.signatures.push(signature);
    existing.parameterNames.push(parsedParams.names);
    existing.parameterTypes.push(parsedParams.types);
  }
  if (!existing.description && description) {
    existing.description = description;
  }
}

function collectLeadingComment(lines: string[], lineNumber: number): string {
  const comments: string[] = [];
  for (let i = lineNumber - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      if (comments.length > 0) {
        break;
      }
      continue;
    }
    if (!trimmed.startsWith('//')) {
      break;
    }
    comments.unshift(trimmed.replace(/^\/\/+\s?/, '').trim());
  }
  return comments.join(' ').trim();
}

function scanUserFunctions(root: string, bucket: Map<string, UserFunctionEntry>) {
  for (const filePath of walk(root, (fullPath) => fullPath.endsWith('.prg') || fullPath.endsWith('.inc'))) {
    let text = '';
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (const [lineNumber, rawLine] of lines.entries()) {
      const line = stripDeclarationComments(rawLine);
      const match = line.match(
        /^\s*(?:(?:private|public|global|local)\s+)?(?:process|function|procedure)\s+([A-Za-z_#][A-Za-z0-9_#]*)\s*(?:\(([^)]*)\))?/i,
      );
      if (!match) {
        continue;
      }
      addUserFunction(bucket, filePath, lineNumber, match[1], collectLeadingComment(lines, lineNumber), match[2]);
    }
  }
}

function scanUserMacros(root: string, bucket: Map<string, UserFunctionEntry>) {
  for (const filePath of walk(root, (fullPath) => fullPath.endsWith('.prg') || fullPath.endsWith('.inc'))) {
    let text = '';
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (const [lineNumber, rawLine] of lines.entries()) {
      const line = stripDeclarationComments(rawLine);
      const match = line.match(/^\s*#define\s+([A-Za-z_#][A-Za-z0-9_#]*)\s*\(([^)]*)\)/i);
      if (!match) {
        continue;
      }
      addUserFunction(bucket, filePath, lineNumber, match[1], collectLeadingComment(lines, lineNumber), match[2]);
    }
  }
}

function rebuildIndex() {
  const next: Record<BennuVersion, Map<string, SymbolEntry>> = {
    v1: new Map<string, SymbolEntry>(),
    v2: new Map<string, SymbolEntry>(),
  };
  const nextUser: Record<BennuVersion, Map<string, UserFunctionEntry>> = {
    v1: new Map<string, UserFunctionEntry>(),
    v2: new Map<string, UserFunctionEntry>(),
  };
  const rootsByVersion: Record<BennuVersion, string[]> = {
    v1: [...sharedSourceRoots, ...sourceRootsByVersion.v1],
    v2: [...sharedSourceRoots, ...sourceRootsByVersion.v2],
  };

  for (const version of ['v1', 'v2'] as BennuVersion[]) {
    const uniqueRoots = [...new Set(rootsByVersion[version].filter((entry) => entry.length > 0))];
    for (const root of uniqueRoots) {
      scanRoot(root, next[version]);
      scanUserFunctions(root, nextUser[version]);
      scanUserMacros(root, nextUser[version]);
    }
  }

  symbolIndexByVersion = next;
  userFunctionIndexByVersion = nextUser;
}

function wordAt(text: string, offset: number): string {
  let start = offset;
  while (start > 0 && /[A-Za-z0-9_#]/.test(text[start - 1])) {
    start -= 1;
  }
  let end = offset;
  while (end < text.length && /[A-Za-z0-9_#]/.test(text[end])) {
    end += 1;
  }
  return text.slice(start, end);
}

function identifierAt(text: string, offset: number): string {
  if (offset >= 0 && offset < text.length && /[A-Za-z0-9_#]/.test(text[offset])) {
    return wordAt(text, offset);
  }
  if (offset - 1 >= 0 && /[A-Za-z0-9_#]/.test(text[offset - 1])) {
    return wordAt(text, offset - 1);
  }
  return '';
}

function positionToOffset(text: string, line: number, character: number): number {
  let offset = 0;
  let currentLine = 0;
  while (offset < text.length && currentLine < line) {
    if (text[offset] === '\n') {
      currentLine += 1;
    }
    offset += 1;
  }
  return Math.min(offset + character, text.length);
}

function currentLinePrefix(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', Math.max(offset - 1, 0)) + 1;
  return text.slice(lineStart, offset);
}

interface CallContext {
  name: string;
  argumentIndex: number;
}

function callContextAt(text: string, offset: number): CallContext | undefined {
  const prefix = currentLinePrefix(text, offset);
  const stack: CallContext[] = [];
  let inString = false;
  let quote = '';

  for (let i = 0; i < prefix.length; i += 1) {
    const ch = prefix[i];
    const next = prefix[i + 1] ?? '';

    if (!inString && ch === '/' && next === '/') {
      break;
    }

    if (inString) {
      if (ch === quote && prefix[i - 1] !== '\\') {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === '\'') {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === '(') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(prefix[j])) {
        j -= 1;
      }
      const end = j + 1;
      while (j >= 0 && /[A-Za-z0-9_#]/.test(prefix[j])) {
        j -= 1;
      }
      const start = j + 1;
      const name = prefix.slice(start, end);
      stack.push({ name, argumentIndex: 0 });
      continue;
    }

    if (ch === ',' && stack.length > 0) {
      stack[stack.length - 1].argumentIndex += 1;
      continue;
    }

    if (ch === ')' && stack.length > 0) {
      stack.pop();
    }
  }

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const ctx = stack[i];
    if (ctx.name) {
      return ctx;
    }
  }
  return undefined;
}

function symbolAtOrNearOffset(text: string, offset: number): string {
  const direct = identifierAt(text, offset);
  if (direct) {
    return direct;
  }
  const ctx = callContextAt(text, offset);
  return ctx?.name ?? '';
}

function isFunctionCallContext(text: string, offset: number): boolean {
  const prefix = currentLinePrefix(text, offset);
  const stack: number[] = [];
  let inString = false;
  let quote = '';

  for (let i = 0; i < prefix.length; i += 1) {
    const ch = prefix[i];
    const next = prefix[i + 1] ?? '';

    if (!inString && ch === '/' && next === '/') {
      break;
    }

    if (inString) {
      if (ch === quote && prefix[i - 1] !== '\\') {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === '\'') {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === '(') {
      stack.push(i);
    } else if (ch === ')' && stack.length > 0) {
      stack.pop();
    }
  }

  if (stack.length === 0) {
    return false;
  }

  const openIndex = stack[stack.length - 1];
  const beforeOpen = prefix.slice(0, openIndex);
  return /[A-Za-z_#][A-Za-z0-9_#]*\s*$/.test(beforeOpen);
}

function createDefinitionLocation(uri: string, line: number, symbol?: string): Location {
  const startCharacter = 0;
  const endCharacter = Math.max(symbol?.length ?? 0, 1);
  return {
    uri,
    range: {
      start: { line: Math.max(line, 0), character: startCharacter },
      end: { line: Math.max(line, 0), character: endCharacter },
    },
  };
}

function findDefinitionLineInText(text: string, symbol: string): number | undefined {
  const escaped = escapeRegExp(symbol);
  const patterns = [
    // Accept common Bennu declaration variants, including optional visibility and return type.
    new RegExp(`^\\s*(?:(?:private|public|global|local)\\s+)?(?:process|function|procedure)\\b[^\\n;]*\\b${escaped}\\b`, 'gim'),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && typeof match.index === 'number') {
      return lineNumberAt(text, match.index);
    }
  }

  return undefined;
}

function findDefinitionInProjectFiles(symbol: string, currentUri: string, version: BennuVersion): Location | undefined {
  const currentPath = uriToPath(currentUri);
  const searchRoots = [
    path.dirname(currentPath),
    ...sharedSourceRoots,
    ...sourceRootsByVersion[version],
  ].filter((root, index, all) => root.length > 0 && all.indexOf(root) === index);

  for (const root of searchRoots) {
    for (const filePath of walk(root, (fullPath) => fullPath.endsWith('.prg') || fullPath.endsWith('.inc'))) {
      let text = '';
      try {
        text = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      const line = findDefinitionLineInText(text, symbol);
      if (line !== undefined) {
        return createDefinitionLocation(pathToUri(filePath), line, symbol);
      }
    }
  }

  return undefined;
}

function toRange(lineNumber: number, start: number, end: number) {
  return {
    start: { line: lineNumber, character: start },
    end: { line: lineNumber, character: end },
  };
}

function signatureText(entry: SymbolEntry): string {
  const displayName = entry.kind === 'function' ? entry.name.toLowerCase() : entry.name;
  if (!entry.signature) {
    return displayName;
  }
  const params = entry.signature
    .split('')
    .filter((ch) => ch !== '+')
    .flatMap((ch) => PARAM_MAP[ch] ?? [ch.toLowerCase()]);
  return `${displayName}(${params.map((type, index) => `${type} arg${index + 1}`).join(', ')})`;
}

function signatureArity(signature: string): number {
  return signature.split('').filter((ch) => ch !== '+').length;
}

function signatureArities(entry: SymbolEntry): number[] {
  if (entry.kind !== 'function') {
    return [];
  }
  const signatures = entry.signatures.length > 0 ? entry.signatures : [entry.signature];
  return [...new Set(signatures.map(signatureArity))];
}

function hoverText(entry: SymbolEntry): string {
  const lines = [`**${signatureText(entry)}**`];
  if (entry.returnType) {
    lines.push(`Returns: \`${entry.returnType}\``);
  }
  if (entry.module) {
    lines.push(`Module: \`${entry.module}\``);
  }
  if (entry.description) {
    lines.push('', entry.description);
  }
  if (entry.source) {
    lines.push(`Source: \`${entry.source}\``);
  }
  const firstSignature = entry.signatures.length > 0 ? entry.signatures[0] : entry.signature;
  const params = firstSignature
    .split('')
    .filter((ch) => ch !== '+')
    .flatMap((ch) => PARAM_MAP[ch] ?? [ch.toLowerCase()]);
  if (params.length > 0) {
    lines.push('', 'Parameters:');
    for (let i = 0; i < params.length; i += 1) {
      lines.push(`- \`${params[i]} arg${i + 1}\` (${i + 1}/${params.length}, remaining ${params.length - i - 1})`);
    }
  }
  if (entry.variants.length > 0) {
    lines.push('', 'Variants:');
    for (const variant of entry.variants) {
      lines.push(`- \`${variant}\``);
    }
  }
  return lines.join('\n').trim();
}

function userFunctionHoverText(entry: UserFunctionEntry): string {
  const signatures = entry.signatures.length > 0 ? entry.signatures : [`${entry.name}()`];
  const lines = [`**${signatures[0]}**`, 'User-defined function/process'];
  if (entry.description) {
    lines.push('', entry.description);
  }
  const names = entry.parameterNames[0] ?? [];
  const types = entry.parameterTypes[0] ?? [];
  if (names.length > 0) {
    lines.push('', 'Parameters:');
    for (let i = 0; i < names.length; i += 1) {
      const type = types[i] ?? 'variant';
      lines.push(`- \`${type} ${names[i]}\` (${i + 1}/${names.length}, remaining ${names.length - i - 1})`);
    }
  }
  if (signatures.length > 1) {
    lines.push('', 'Variants:');
    for (const variant of signatures.slice(1)) {
      lines.push(`- \`${variant}\``);
    }
  }
  return lines.join('\n').trim();
}

function inferLiteralType(argument: string): 'string' | 'number' | 'unknown' {
  const value = argument.trim();
  if (!value) {
    return 'unknown';
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith('\'') && value.endsWith('\'')) ||
    /"(?:[^"\\]|\\.)*"/.test(value) ||
    /'(?:[^'\\]|\\.)*'/.test(value)
  ) {
    return 'string';
  }
  if (/^[-+]?((\d+(\.\d+)?)|(\.\d+))$/.test(value) || /^0x[0-9a-f]+$/i.test(value) || /^[0-9+\-*/%().\s]+$/.test(value)) {
    return 'number';
  }
  return 'unknown';
}

function coreSignatureParamTypes(signature: string): (string | undefined)[] {
  return signature
    .split('')
    .filter((ch) => ch !== '+')
    .flatMap((ch) => PARAM_MAP[ch] ?? [undefined])
    .map((entry) => entry ?? undefined);
}

function isTypeCompatible(expected: string | undefined, actual: 'string' | 'number' | 'unknown'): boolean {
  if (!expected || actual === 'unknown' || expected === 'variant') {
    return true;
  }
  if (expected === 'string') {
    return actual === 'string';
  }
  if (NUMERIC_TYPES.has(expected)) {
    return actual === 'number';
  }
  return true;
}

function coreEntrySignatureInfo(entry: SymbolEntry): SignatureInformation[] {
  const signatures = entry.signatures.length > 0 ? entry.signatures : [entry.signature];
  return signatures.map((sig) => {
    const params = sig
      .split('')
      .filter((ch) => ch !== '+')
      .flatMap((ch) => PARAM_MAP[ch] ?? [ch.toLowerCase()]);
    const typedParams = params.map((param, index) => `${param} arg${index + 1}`);
    const label = `${entry.name.toLowerCase()}(${typedParams.join(', ')})`;
    const documentation = [entry.description, entry.module ? `Module: ${entry.module}` : '', entry.source ? `Source: ${entry.source}` : '']
      .filter((part) => part.length > 0)
      .join('\n');
    return SignatureInformation.create(
      label,
      documentation,
      ...params.map((param, index) =>
        ParameterInformation.create(
          `${param} arg${index + 1}`,
          `Parameter ${index + 1} of ${params.length}. Remaining after this: ${Math.max(params.length - index - 1, 0)}.`,
        )),
    );
  });
}

function coreSignatureLabels(entry: SymbolEntry): string[] {
  const signatures = entry.signatures.length > 0 ? entry.signatures : [entry.signature];
  return signatures.map((sig) => {
    const params = sig
      .split('')
      .filter((ch) => ch !== '+')
      .flatMap((ch) => PARAM_MAP[ch] ?? [ch.toLowerCase()]);
    return `${entry.name.toLowerCase()}(${params.map((type, index) => `${type} arg${index + 1}`).join(', ')})`;
  });
}

function userSignatureLabels(entry: UserFunctionEntry): string[] {
  const signatures = entry.signatures.length > 0 ? entry.signatures : [`${entry.name}()`];
  return signatures.map((_, index) => {
    const names = entry.parameterNames[index] ?? [];
    const types = entry.parameterTypes[index] ?? [];
    const params = names.map((name, paramIndex) => `${types[paramIndex] ?? 'variant'} ${name}`.trim());
    return `${entry.name}(${params.join(', ')})`;
  });
}

function expectedSignaturesText(entry?: SymbolEntry, userEntry?: UserFunctionEntry): string | undefined {
  const labels = userEntry ? userSignatureLabels(userEntry) : entry ? coreSignatureLabels(entry) : [];
  if (labels.length === 0) {
    return undefined;
  }
  const shown = labels.slice(0, 3).map((label) => `\`${label}\``);
  const suffix = labels.length > 3 ? ` (+${labels.length - 3} more)` : '';
  return `Expected signatures: ${shown.join(' | ')}${suffix}`;
}

function userEntrySignatureInfo(entry: UserFunctionEntry): SignatureInformation[] {
  const signatures = userSignatureLabels(entry);
  return signatures.map((sig, index) => {
    const params = entry.parameterNames[index] ?? [];
    return SignatureInformation.create(
      sig,
      entry.description ? `User-defined function/process\n${entry.description}` : 'User-defined function/process',
      ...params.map((param, paramIndex) => {
        const type = entry.parameterTypes[index]?.[paramIndex] ?? 'variant';
        return ParameterInformation.create(
          `${type} ${param}`.trim(),
          `Parameter ${paramIndex + 1} of ${params.length}. Remaining after this: ${Math.max(params.length - paramIndex - 1, 0)}.`,
        );
      }),
    );
  });
}

function keywordItems(prefix: string) {
  const upperPrefix = prefix.toUpperCase();
  return BENNUGD_KEYWORDS
    .filter((keyword) => !upperPrefix || keyword.toUpperCase().startsWith(upperPrefix))
    .sort((a, b) => a.localeCompare(b))
    .map((keyword) => ({
      label: keyword,
      kind: CompletionItemKind.Keyword,
      detail: 'BennuGD keyword',
      insertText: keyword,
      filterText: keyword.toUpperCase(),
      sortText: `0_${keyword}`,
    }));
}

function parseDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const pattern = /^(.*?):(\d+):(?:\d+:)?(error|warning|info):\s*(.*)$/i;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const match = line.match(pattern);
    if (!match) {
      continue;
    }
    const [, fileName, lineNo, severity, message] = match;
    const sev = severity.toLowerCase();
    const diagnosticSeverity =
      sev === 'error' ? DiagnosticSeverity.Error : sev === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information;
    diagnostics.push({
      severity: diagnosticSeverity,
      range: {
        start: { line: Math.max(Number(lineNo) - 1, 0), character: 0 },
        end: { line: Math.max(Number(lineNo) - 1, 0), character: 200 },
      },
      source: 'bgdc',
      message: `${path.basename(fileName)}: ${message}`,
    });
  }
  return diagnostics;
}

function splitArguments(argumentText: string): string[] {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let quote = '';

  for (let i = 0; i < argumentText.length; i += 1) {
    const ch = argumentText[i];
    const prev = i > 0 ? argumentText[i - 1] : '';

    if (inString) {
      current += ch;
      if (ch === quote && prev !== '\\') {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === '\'') {
      inString = true;
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '(') {
      depth += 1;
      current += ch;
      continue;
    }

    if (ch === ')') {
      depth = Math.max(depth - 1, 0);
      current += ch;
      continue;
    }

    if (ch === ',' && depth === 0) {
      if (current.trim()) {
        args.push(current.trim());
      }
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

function codeWithoutComments(line: string): string {
  let output = '';
  let inString = false;
  let quote = '';

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1] ?? '';

    if (inString) {
      if (ch === quote && line[i - 1] !== '\\') {
        inString = false;
      }
      output += ch;
      continue;
    }

    if (ch === '"' || ch === '\'') {
      inString = true;
      quote = ch;
      output += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      return `${output}${' '.repeat(line.length - i)}`;
    }

    if (ch === '/' && next === '*') {
      return `${output}${' '.repeat(line.length - i)}`;
    }

    output += ch;
  }

  return output;
}

function codeForTokenDiagnostics(line: string): string {
  const code = codeWithoutComments(line);
  let output = '';
  let inString = false;
  let quote = '';

  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    const prev = i > 0 ? code[i - 1] : '';

    if (inString) {
      output += ' ';
      if (ch === quote && prev !== '\\') {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === '\'') {
      inString = true;
      quote = ch;
      output += ' ';
      continue;
    }

    output += ch;
  }

  return output;
}

interface CallMatch {
  name: string;
  args: string;
  start: number;
  end: number;
}

function extractCallMatches(line: string): CallMatch[] {
  const matches: CallMatch[] = [];
  const code = codeWithoutComments(line);
  let i = 0;

  while (i < code.length) {
    const ch = code[i];
    if (!/[A-Za-z_#]/.test(ch)) {
      i += 1;
      continue;
    }

    const start = i;
    i += 1;
    while (i < code.length && /[A-Za-z0-9_#]/.test(code[i])) {
      i += 1;
    }
    const name = code.slice(start, i);

    while (i < code.length && /\s/.test(code[i])) {
      i += 1;
    }

    if (code[i] !== '(') {
      continue;
    }

    const argsStart = i + 1;
    let depth = 1;
    let inString = false;
    let quote = '';
    i += 1;

    while (i < code.length && depth > 0) {
      const current = code[i];
      const prev = i > 0 ? code[i - 1] : '';

      if (inString) {
        if (current === quote && prev !== '\\') {
          inString = false;
        }
        i += 1;
        continue;
      }

      if (current === '"' || current === '\'') {
        inString = true;
        quote = current;
        i += 1;
        continue;
      }

      if (current === '(') {
        depth += 1;
      } else if (current === ')') {
        depth -= 1;
      }
      i += 1;
    }

    if (depth === 0) {
      const argsEnd = i - 1;
      matches.push({
        name,
        args: code.slice(argsStart, argsEnd),
        start,
        end: i,
      });
    }
  }

  return matches;
}

function collectLiveDiagnostics(text: string, version: BennuVersion): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = text.split(/\r?\n/);
  const index = getIndex(version);
  const userFunctions = userFunctionIndexByVersion[version];

  for (const [lineNumber, line] of lines.entries()) {
    const codeForTokens = codeForTokenDiagnostics(line);

    const invalidTokenPattern = /\b\d+[A-Za-z_][A-Za-z0-9_]*\b/g;
    for (const match of codeForTokens.matchAll(invalidTokenPattern)) {
      const token = match[0];
      const start = match.index ?? 0;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: toRange(lineNumber, start, start + token.length),
        source: 'bennugd',
        message: `Invalid token '${token}'. Identifiers cannot start with a digit.`,
      });
    }

    for (const match of extractCallMatches(line)) {
      const callName = match.name.toUpperCase();
      const entry = index.get(callName);
      const userEntry = userFunctions.get(callName);
      const expectedArgs =
        userEntry
          ? userEntry.arities
          : entry && entry.kind === 'function' && entry.signature
            ? signatureArities(entry)
            : [];
      const displayName = userEntry?.name ?? entry?.name ?? match.name;
      if (expectedArgs.length === 0) {
        continue;
      }

      const actualArgs = splitArguments(match.args);
      if (!expectedArgs.includes(actualArgs.length)) {
        const signatureHint = expectedSignaturesText(entry, userEntry);
        const descriptionHint = userEntry?.description || entry?.description;
        const detailLines = [
          `${displayName} expects ${expectedArgs.join(' or ')} argument(s) but got ${actualArgs.length}.`,
          signatureHint,
          descriptionHint ? `Description: ${descriptionHint}` : undefined,
        ].filter((line): line is string => Boolean(line));
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: toRange(lineNumber, match.start, match.end),
          source: 'bennugd',
          message: detailLines.join('\n'),
        });
        continue;
      }

      const candidateParamTypes: (string | undefined)[][] = [];
      if (userEntry) {
        for (const types of userEntry.parameterTypes) {
          if (types.length === actualArgs.length) {
            candidateParamTypes.push(types);
          }
        }
      } else if (entry && entry.kind === 'function') {
        const signatures = entry.signatures.length > 0 ? entry.signatures : [entry.signature];
        for (const sig of signatures) {
          const types = coreSignatureParamTypes(sig);
          if (types.length === actualArgs.length) {
            candidateParamTypes.push(types);
          }
        }
      }

      if (candidateParamTypes.length === 0) {
        continue;
      }

      const actualTypes = actualArgs.map(inferLiteralType);
      const hasCompatibleSignature = candidateParamTypes.some((paramTypes) =>
        paramTypes.every((expected, index) => isTypeCompatible(expected, actualTypes[index])));

      if (!hasCompatibleSignature) {
        const signatureHint = expectedSignaturesText(entry, userEntry);
        const descriptionHint = userEntry?.description || entry?.description;
        const detailLines = [
          `${displayName} argument types do not match expected signature.`,
          signatureHint,
          descriptionHint ? `Description: ${descriptionHint}` : undefined,
        ].filter((line): line is string => Boolean(line));
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: toRange(lineNumber, match.start, match.end),
          source: 'bennugd',
          message: detailLines.join('\n'),
        });
      }
    }
  }

  return diagnostics;
}

function compileForDiagnostics(filePath: string, version: BennuVersion): Promise<string> {
  const compilerPath = compilerPathByVersion[version];
  if (!compilerPath) {
    return Promise.resolve('');
  }
  const cwd = path.dirname(filePath);
  const root = (version === 'v1' ? sourceRootsByVersion.v1 : sourceRootsByVersion.v2)[0] ?? sharedSourceRoots[0] ?? cwd;
  const args = ['-i', root, '-d', filePath];
  return new Promise((resolve) => {
    const child = spawn(compilerPath, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('close', () => resolve(output));
    child.on('error', () => resolve(''));
  });
}

connection.onInitialize((params: InitializeParams) => {
  initializationOptions = (params.initializationOptions as InitializationOptions) ?? {};
  defaultVersion = initializationOptions.defaultVersion ?? 'v2';
  sharedSourceRoots = (initializationOptions.sourceRoots ?? []).map((entry) => path.resolve(entry)).filter((entry) => entry.length > 0);
  sourceRootsByVersion = {
    v1: (initializationOptions.v1SourceRoots ?? []).map((entry) => path.resolve(entry)).filter((entry) => entry.length > 0),
    v2: (initializationOptions.v2SourceRoots ?? []).map((entry) => path.resolve(entry)).filter((entry) => entry.length > 0),
  };
  compilerPathByVersion = {
    v1: initializationOptions.v1CompilerPath?.trim() ?? initializationOptions.compilerPath?.trim() ?? '',
    v2: initializationOptions.v2CompilerPath?.trim() ?? initializationOptions.compilerPath?.trim() ?? '',
  };

  if (sharedSourceRoots.length === 0 && params.workspaceFolders?.length) {
    sharedSourceRoots = params.workspaceFolders.map((folder) => uriToPath(folder.uri));
  }
  if (sharedSourceRoots.length === 0 && params.rootUri) {
    sharedSourceRoots = [uriToPath(params.rootUri)];
  }
  if (sharedSourceRoots.length === 0) {
    sharedSourceRoots = [process.cwd()];
  }

  rebuildIndex();

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ['_', '#'] },
      hoverProvider: true,
      signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [','] },
      documentSymbolProvider: true,
    },
  };
});

documents.onDidOpen((event) => {
  openDocuments.set(event.document.uri, event.document.getText());
  const version = versionFromLanguageId(event.document.languageId);
  documentVersions.set(event.document.uri, version);
  connection.sendDiagnostics({
    uri: event.document.uri,
    diagnostics: collectLiveDiagnostics(event.document.getText(), version),
  });
});

documents.onDidChangeContent((event) => {
  openDocuments.set(event.document.uri, event.document.getText());
  const version = getDocumentVersion(event.document.uri);
  connection.sendDiagnostics({
    uri: event.document.uri,
    diagnostics: collectLiveDiagnostics(event.document.getText(), version),
  });
});

documents.onDidClose((event) => {
  openDocuments.delete(event.document.uri);
  documentVersions.delete(event.document.uri);
});

connection.onCompletion((params) => {
  const text = openDocuments.get(params.textDocument.uri) ?? '';
  const offset = positionToOffset(text, params.position.line, params.position.character);
  const prefix = wordAt(text, offset).toUpperCase();
  const version = getDocumentVersion(params.textDocument.uri);
  const index = getIndex(version);
  const userIndex = userFunctionIndexByVersion[version];
  const functionContext = isFunctionCallContext(text, offset);
  const coreItems = [...index.values()]
    .filter((entry) => entry.kind !== 'function' || functionContext)
    .filter((entry) => !prefix || entry.key.startsWith(prefix))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 200)
    .map((entry) => ({
      label: entry.kind === 'function' ? entry.name.toLowerCase() : entry.name,
      kind: entry.kind === 'function' ? CompletionItemKind.Function : CompletionItemKind.Constant,
      detail: signatureText(entry),
      documentation: hoverText(entry),
      insertText: entry.kind === 'function' ? entry.name.toLowerCase() : entry.name,
      filterText: entry.key,
      sortText: entry.kind === 'function' ? `1_${entry.key}` : `2_${entry.key}`,
    }));
  const userItems = functionContext
    ? [...userIndex.values()]
      .filter((entry) => !prefix || entry.key.startsWith(prefix))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200)
      .map((entry) => ({
        label: entry.name,
        kind: CompletionItemKind.Function,
        detail: entry.signatures[0] ?? `${entry.name}()`,
        documentation: userFunctionHoverText(entry),
        insertText: entry.name,
        filterText: entry.key,
        sortText: `1_${entry.key}`,
      }))
    : [];

  const seenLabels = new Set<string>();
  const mergedFunctionItems = [...userItems, ...coreItems].filter((item) => {
    const key = String(item.label).toUpperCase();
    if (seenLabels.has(key)) {
      return false;
    }
    seenLabels.add(key);
    return true;
  });

  const items = [
    ...keywordItems(prefix),
    ...mergedFunctionItems,
  ];
  return { isIncomplete: functionContext, items };
});

connection.onHover((params): Hover | undefined => {
  const text = openDocuments.get(params.textDocument.uri) ?? '';
  const offset = positionToOffset(text, params.position.line, params.position.character);
  const symbol = identifierAt(text, offset).toUpperCase();
  if (!symbol) {
    return undefined;
  }
  const version = getDocumentVersion(params.textDocument.uri);
  const userEntry = userFunctionIndexByVersion[version].get(symbol);
  if (userEntry) {
    return {
      contents: {
        kind: 'markdown',
        value: userFunctionHoverText(userEntry),
      },
    };
  }

  const entry = getIndex(version).get(symbol);
  if (entry) {
    return {
      contents: {
        kind: 'markdown',
        value: hoverText(entry),
      },
    };
  }
  return undefined;
});

connection.onSignatureHelp((params): SignatureHelp | undefined => {
  const text = openDocuments.get(params.textDocument.uri) ?? '';
  const offset = positionToOffset(text, params.position.line, params.position.character);
  const version = getDocumentVersion(params.textDocument.uri);
  const ctx = callContextAt(text, offset);
  if (!ctx?.name) {
    return undefined;
  }

  const key = ctx.name.toUpperCase();
  const coreEntry = getIndex(version).get(key);
  const userEntry = userFunctionIndexByVersion[version].get(key);
  const signatures = userEntry
    ? userEntrySignatureInfo(userEntry)
    : coreEntry
      ? coreEntrySignatureInfo(coreEntry)
      : [];

  if (signatures.length === 0) {
    return undefined;
  }

  const firstSignatureParams = signatures[0].parameters ?? [];
  const activeParameter = firstSignatureParams.length > 0
    ? Math.min(ctx.argumentIndex, firstSignatureParams.length - 1)
    : 0;

  return {
    signatures,
    activeSignature: 0,
    activeParameter,
  };
});

connection.onDefinition((params): Location[] | undefined => {
  const text = openDocuments.get(params.textDocument.uri) ?? '';
  const offset = positionToOffset(text, params.position.line, params.position.character);
  const symbol = symbolAtOrNearOffset(text, offset);
  if (!symbol) {
    return undefined;
  }

  const version = getDocumentVersion(params.textDocument.uri);
  const userEntry = userFunctionIndexByVersion[version].get(symbol.toUpperCase());
  if (userEntry?.definitionUri) {
    return [createDefinitionLocation(userEntry.definitionUri, userEntry.definitionLine ?? 0, symbol)];
  }
  const entry = getIndex(version).get(symbol.toUpperCase());
  if (entry?.definitionUri) {
    return [createDefinitionLocation(entry.definitionUri, entry.definitionLine ?? 0, symbol)];
  }

  const localLine = findDefinitionLineInText(text, symbol);
  if (localLine !== undefined) {
    return [createDefinitionLocation(params.textDocument.uri, localLine, symbol)];
  }

  const projectLocation = findDefinitionInProjectFiles(symbol, params.textDocument.uri, version);
  if (projectLocation) {
    return [projectLocation];
  }

  return undefined;
});

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const text = openDocuments.get(params.textDocument.uri) ?? '';
  const result: DocumentSymbol[] = [];
  for (const [lineNumber, line] of text.split(/\r?\n/).entries()) {
    const match = line.trim().match(/^(process|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (!match) {
      continue;
    }
    const name = match[2];
    const index = line.indexOf(name);
    result.push({
      name,
      kind: match[1].toLowerCase() === 'struct' ? SymbolKind.Struct : SymbolKind.Function,
      range: {
        start: { line: lineNumber, character: 0 },
        end: { line: lineNumber, character: line.length },
      },
      selectionRange: {
        start: { line: lineNumber, character: Math.max(index, 0) },
        end: { line: lineNumber, character: Math.max(index, 0) + name.length },
      },
    });
  }
  return result;
});

documents.onDidSave(async (event) => {
  const savedPath = uriToPath(event.document.uri);
  const ext = path.extname(savedPath).toLowerCase();
  if (ext === '.prg' || ext === '.inc' || ext === '.h' || ext === '.c') {
    rebuildIndex();
  }

  const version = getDocumentVersion(event.document.uri);
  const liveDiagnostics = collectLiveDiagnostics(event.document.getText(), version);
  const compilerDiagnostics = parseDiagnostics(await compileForDiagnostics(savedPath, version));
  const diagnostics = [...liveDiagnostics, ...compilerDiagnostics];
  connection.sendDiagnostics({
    uri: event.document.uri,
    diagnostics,
  });
});

connection.onNotification('bennugd/documentVersion', (params: { uri: string; version: BennuVersion }) => {
  documentVersions.set(params.uri, params.version);
  const text = openDocuments.get(params.uri);
  if (text !== undefined) {
    const version = params.version;
    connection.sendDiagnostics({
      uri: params.uri,
      diagnostics: collectLiveDiagnostics(text, version),
    });
  }
});

documents.listen(connection);
connection.listen();
