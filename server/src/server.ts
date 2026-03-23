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
let projectGlobalVariableIndexByVersion: Record<BennuVersion, Map<string, string>> = { v1: new Map(), v2: new Map() };
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
const BUILTIN_NUMERIC_INTRINSICS = new Set(['SIZEOF']);
const EXPRESSION_OPERATOR_KEYWORDS = new Set(['MOD', 'DIV', 'AND', 'OR', 'XOR', 'NOT']);
const INDEXED_MEMBER_ACCESS_PATTERN = /\b[A-Za-z_#][A-Za-z0-9_#]*(?:\[[^\]\r\n]*\])*(?:\.[A-Za-z_#][A-Za-z0-9_#]*(?:\[[^\]\r\n]*\])*)+\b/g;
const TYPED_DECLARATION_SEGMENT_PATTERN =
  /(?:(?:local|global|private|public)\s+)?(int|double|float|qword|dword|word|short|byte|string|pointer|variant)\b([^;]*)/gi;

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

function isProjectSourceFile(fullPath: string): boolean {
  return fullPath.endsWith('.prg') || fullPath.endsWith('.inc') || fullPath.endsWith('.lib');
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
  const func = line.match(/FUNC\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*TYPE_([A-Z_]+)\s*,\s*(.+?)\s*\)\s*,?/);
  if (func) {
    const [, name, signature, rawType, rawSourceExpr] = func;
    const key = name.toUpperCase();
    const returnType = TYPE_MAP[`TYPE_${rawType}`] ?? rawType.toLowerCase();
    const sourceExpr = rawSourceExpr.trim();
    const sourceFromComment = line.match(/\/\/\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
    const sourceFromExpr = sourceExpr.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
    const source = sourceFromComment ?? sourceFromExpr ?? sourceExpr;
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
  let currentDeclaredType: string | undefined;

  for (const part of parts) {
    const normalized = part.replace(/&/g, ' ').trim();
    const tokens = normalized.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) {
      continue;
    }
    const maybeType = tokens[0].toLowerCase();
    if (KNOWN_PARAM_TYPES.has(maybeType)) {
      if (tokens.length >= 2) {
        currentDeclaredType = maybeType;
        types.push(maybeType);
        names.push(tokens.slice(1).join(' '));
      } else {
        currentDeclaredType = maybeType;
      }
      continue;
    }

    types.push(currentDeclaredType);
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
  for (const filePath of walk(root, isProjectSourceFile)) {
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
        /^\s*(?:(?:private|public|global|local)\s+)?(?:process|procedure|function\s+(?:(?:int|double|float|qword|dword|word|short|byte|string|pointer|variant)\s+)?)\s*([A-Za-z_#][A-Za-z0-9_#]*)\s*(?:\(([^)]*)\))?/i,
      );
      if (!match) {
        continue;
      }
      addUserFunction(bucket, filePath, lineNumber, match[1], collectLeadingComment(lines, lineNumber), match[2]);
    }
  }
}

function scanUserMacros(root: string, bucket: Map<string, UserFunctionEntry>) {
  for (const filePath of walk(root, isProjectSourceFile)) {
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

function collectTopLevelTypedDeclarations(text: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const code = stripCommentsPreservingLength(text);
  const lines = code.split(/\r?\n/);
  let inTypeBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (/^(?:private|public|global|local)?\s*(?:process|function|procedure)\b/i.test(line)) {
      break;
    }

    if (/^type\b/i.test(line)) {
      inTypeBlock = true;
      continue;
    }
    if (inTypeBlock) {
      if (/^end\b/i.test(line)) {
        inTypeBlock = false;
      }
      continue;
    }

    for (const match of rawLine.matchAll(new RegExp(TYPED_DECLARATION_SEGMENT_PATTERN))) {
      const declaredType = (match[1] ?? '').toLowerCase();
      const rest = (match[2] ?? '').trim();
      if (!declaredType || !rest || rest.includes('(')) {
        continue;
      }
      const declarators = splitArguments(rest);
      for (const declarator of declarators) {
        const identifierMatch = declarator.match(/[A-Za-z_#][A-Za-z0-9_#]*/);
        if (!identifierMatch) {
          continue;
        }
        declarations.set(identifierMatch[0].toUpperCase(), declaredType);
      }
    }
  }

  return declarations;
}

function mergeProjectVariableType(existing: string | undefined, incoming: string): string {
  if (!existing) {
    return incoming;
  }
  if (existing === incoming) {
    return existing;
  }
  if (NUMERIC_TYPES.has(existing) && NUMERIC_TYPES.has(incoming)) {
    return 'int';
  }
  return 'variant';
}

function scanProjectGlobalVariables(root: string, bucket: Map<string, string>) {
  for (const filePath of walk(root, isProjectSourceFile)) {
    let text = '';
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const topLevelDeclarations = collectTopLevelTypedDeclarations(text);
    for (const [name, declaredType] of topLevelDeclarations.entries()) {
      const existing = bucket.get(name);
      bucket.set(name, mergeProjectVariableType(existing, declaredType));
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
  const nextProjectGlobals: Record<BennuVersion, Map<string, string>> = {
    v1: new Map<string, string>(),
    v2: new Map<string, string>(),
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
      scanProjectGlobalVariables(root, nextProjectGlobals[version]);
    }
  }

  symbolIndexByVersion = next;
  userFunctionIndexByVersion = nextUser;
  projectGlobalVariableIndexByVersion = nextProjectGlobals;
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

interface MemberAccessContext {
  baseIdentifier: string;
  memberPrefix: string;
}

interface DocumentTypeField {
  name: string;
  type: string;
}

interface DocumentTypeDefinition {
  name: string;
  fields: DocumentTypeField[];
}

interface DocumentTypeContext {
  types: Map<string, DocumentTypeDefinition>;
  variables: Map<string, string>;
}

const BUILTIN_PROCESS_FIELDS: DocumentTypeField[] = [
  { name: 'file', type: 'int' },
  { name: 'graph', type: 'int' },
  { name: 'x', type: 'double' },
  { name: 'y', type: 'double' },
  { name: 'z', type: 'int' },
  { name: 'size', type: 'double' },
  { name: 'real_size', type: 'double' },
  { name: 'angle', type: 'int' },
  { name: 'flags', type: 'int' },
  { name: 'priority', type: 'int' },
  { name: 'alpha', type: 'int' },
  { name: 'region', type: 'int' },
  { name: 'resolution', type: 'int' },
  { name: 'ctype', type: 'int' },
  { name: 'status', type: 'int' },
  { name: 'signal', type: 'int' },
  { name: 'id', type: 'int' },
  { name: 'father', type: 'process' },
  { name: 'son', type: 'process' },
];

const BUILTIN_PROCESS_SYMBOLS = new Set(['FATHER', 'SON', 'MYSELF', 'BACKGROUND']);
const BUILTIN_IMPLICIT_IDENTIFIER_TYPES = new Map<string, string>([
  ...BUILTIN_PROCESS_FIELDS.map((field): [string, string] => [field.name.toUpperCase(), field.type]),
  ['MYSELF', 'process'],
  ['BACKGROUND', 'process'],
]);

function memberAccessContextAt(text: string, offset: number): MemberAccessContext | undefined {
  let i = offset - 1;
  while (i >= 0 && /[A-Za-z0-9_#]/.test(text[i])) {
    i -= 1;
  }
  const memberPrefix = text.slice(i + 1, offset);
  if (i < 0 || text[i] !== '.') {
    return undefined;
  }

  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) {
    j -= 1;
  }
  const baseEnd = j + 1;
  while (j >= 0 && /[A-Za-z0-9_#]/.test(text[j])) {
    j -= 1;
  }
  const baseIdentifier = text.slice(j + 1, baseEnd);
  if (!/^[A-Za-z_#][A-Za-z0-9_#]*$/.test(baseIdentifier)) {
    return undefined;
  }

  return { baseIdentifier, memberPrefix };
}

function parseDeclarationIdentifiers(declarationText: string): string[] {
  const cleaned = declarationText.replace(/;.*$/, '').trim();
  if (!cleaned) {
    return [];
  }
  return splitArguments(cleaned)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => {
      const match = item.match(/[A-Za-z_#][A-Za-z0-9_#]*/);
      return match?.[0] ?? '';
    })
    .filter((identifier) => identifier.length > 0);
}

function collectDocumentTypeContext(text: string): DocumentTypeContext {
  const types = new Map<string, DocumentTypeDefinition>();
  const variables = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  let currentType: DocumentTypeDefinition | undefined;

  for (const rawLine of lines) {
    const line = stripDeclarationComments(rawLine);
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (currentType) {
      if (/^end\b/i.test(trimmed)) {
        types.set(currentType.name.toUpperCase(), currentType);
        currentType = undefined;
        continue;
      }

      const fieldMatch = line.match(/^\s*([A-Za-z_#][A-Za-z0-9_#]*)\s+(.+)$/);
      if (!fieldMatch) {
        continue;
      }
      const fieldType = fieldMatch[1];
      for (const fieldName of parseDeclarationIdentifiers(fieldMatch[2])) {
        currentType.fields.push({ name: fieldName, type: fieldType.toLowerCase() });
      }
      continue;
    }

    const typeMatch = line.match(/^\s*type\s+([A-Za-z_#][A-Za-z0-9_#]*)\b/i);
    if (typeMatch) {
      currentType = { name: typeMatch[1], fields: [] };
      continue;
    }

    const variableMatch = line.match(/^\s*(?:(?:local|global|private|public)\s+)?([A-Za-z_#][A-Za-z0-9_#]*)\s+(.+)$/i);
    if (!variableMatch) {
      continue;
    }
    const typeName = variableMatch[1];
    if (
      /^(process|function|procedure|type|if|for|while|loop|switch|case|default|return|break|include|import|program|begin|end)$/i.test(
        typeName,
      )
    ) {
      continue;
    }
    const declarationTail = variableMatch[2];
    if (/\(/.test(declarationTail)) {
      continue;
    }
    for (const variableName of parseDeclarationIdentifiers(declarationTail)) {
      variables.set(variableName.toUpperCase(), typeName.toUpperCase());
    }
  }

  if (currentType) {
    types.set(currentType.name.toUpperCase(), currentType);
  }

  if (!types.has('PROCESS')) {
    types.set('PROCESS', {
      name: 'process',
      fields: [...BUILTIN_PROCESS_FIELDS],
    });
  }
  for (const symbol of BUILTIN_PROCESS_SYMBOLS) {
    if (!variables.has(symbol)) {
      variables.set(symbol, 'PROCESS');
    }
  }

  return { types, variables };
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
    for (const filePath of walk(root, isProjectSourceFile)) {
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
  if (/^(true|false)$/i.test(value)) {
    return 'number';
  }
  if (/^"(?:[^"\\]|\\.)*"$/.test(value) || /^'(?:[^'\\]|\\.)*'$/.test(value)) {
    return 'string';
  }
  if (
    /^[-+]?((\d+(\.\d+)?)|(\.\d+))$/.test(value) ||
    /^0x[0-9a-f]+$/i.test(value) ||
    /^[0-9a-f]+h$/i.test(value) ||
    /^[0-9+\-*/%().\s]+$/.test(value)
  ) {
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

function isTypeCompatible(expected: string | undefined, actual: ResolvedArgType): boolean {
  if (!expected || expected === 'variant') {
    return true;
  }
  if (actual.kind === 'variant') {
    return true;
  }
  if (actual.unresolvedIdentifier) {
    return false;
  }
  if (actual.kind === 'unknown') {
    return true;
  }
  if (expected === 'string') {
    return actual.kind === 'string' || actual.isNullLiteral === true;
  }
  if (expected === 'pointer') {
    return actual.kind === 'pointer' || actual.kind === 'number';
  }
  if (NUMERIC_TYPES.has(expected)) {
    return actual.kind === 'number';
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
  argsStart: number;
  argsEnd: number;
  start: number;
  end: number;
}

interface ResolvedArgType {
  kind: 'string' | 'number' | 'pointer' | 'variant' | 'unknown';
  unresolvedIdentifier?: string;
  isNullLiteral?: boolean;
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function positionAtOffset(lineStarts: number[], offset: number): { line: number; character: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = lineStarts[mid];
    const next = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Number.MAX_SAFE_INTEGER;
    if (offset < start) {
      high = mid - 1;
      continue;
    }
    if (offset >= next) {
      low = mid + 1;
      continue;
    }
    return { line: mid, character: Math.max(offset - start, 0) };
  }
  const lastLine = Math.max(lineStarts.length - 1, 0);
  return { line: lastLine, character: 0 };
}

function rangeFromOffsets(lineStarts: number[], startOffset: number, endOffset: number) {
  return {
    start: positionAtOffset(lineStarts, Math.max(startOffset, 0)),
    end: positionAtOffset(lineStarts, Math.max(endOffset, startOffset + 1)),
  };
}

function stripCommentsPreservingLength(text: string): string {
  let output = '';
  let inString = false;
  let quote = '';
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1] ?? '';
    const prev = i > 0 ? text[i - 1] : '';

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        output += '\n';
      } else {
        output += ' ';
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '\n') {
        output += '\n';
        continue;
      }
      if (ch === '*' && next === '/') {
        output += '  ';
        i += 1;
        inBlockComment = false;
        continue;
      }
      output += ' ';
      continue;
    }

    if (inString) {
      output += ch;
      if (ch === quote && prev !== '\\') {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === '\'') {
      inString = true;
      quote = ch;
      output += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      output += '  ';
      i += 1;
      inLineComment = true;
      continue;
    }

    if (ch === '/' && next === '*') {
      output += '  ';
      i += 1;
      inBlockComment = true;
      continue;
    }

    output += ch;
  }

  return output;
}

function normalizeDeclaredType(typeName?: string): 'string' | 'number' | 'pointer' | 'variant' | 'unknown' {
  const type = (typeName ?? '').trim().toLowerCase();
  if (!type) {
    return 'unknown';
  }
  if (type === 'string') {
    return 'string';
  }
  if (type === 'pointer') {
    return 'pointer';
  }
  if (type === 'variant') {
    return 'variant';
  }
  if (NUMERIC_TYPES.has(type)) {
    return 'number';
  }
  return 'unknown';
}

function normalizeMemberAccessPath(memberAccess: string): string {
  return memberAccess.replace(/\[[^\]\r\n]*\]/g, '');
}

function resolveMemberAccessType(
  memberAccess: string,
  variableTypes: Map<string, string>,
  typeContext: DocumentTypeContext,
): ResolvedArgType {
  const normalizedAccess = normalizeMemberAccessPath(memberAccess);
  const segments = normalizedAccess.split('.').map((segment) => segment.trim()).filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return { kind: 'unknown' };
  }

  const baseKey = segments[0].toUpperCase();
  let currentType = typeContext.variables.get(baseKey) ?? variableTypes.get(baseKey);
  if (!currentType) {
    // Base symbol may come from includes/other modules not indexed in-document.
    // Keep it unknown (non-blocking) instead of reporting a hard unresolved identifier.
    return { kind: 'unknown' };
  }

  for (let i = 1; i < segments.length; i += 1) {
    const typeName = currentType.toUpperCase();
    const typeDefinition = typeContext.types.get(typeName);
    if (!typeDefinition) {
      return { kind: normalizeDeclaredType(currentType) };
    }

    const fieldName = segments[i];
    const field = typeDefinition.fields.find((entry) => entry.name.toUpperCase() === fieldName.toUpperCase());
    if (!field) {
      if (typeName === 'PROCESS') {
        // Process instances can expose project-specific public members not present in the core builtin model.
        return { kind: 'unknown' };
      }
      return { kind: 'unknown', unresolvedIdentifier: segments.slice(0, i + 1).join('.') };
    }
    currentType = field.type;
  }

  return { kind: normalizeDeclaredType(currentType) };
}

function resolveIdentifierType(
  identifier: string,
  variableTypes: Map<string, string>,
  version: BennuVersion,
  typeContext?: DocumentTypeContext,
): ResolvedArgType {
  const key = identifier.toUpperCase();
  if (BUILTIN_NUMERIC_INTRINSICS.has(key)) {
    return { kind: 'number' };
  }
  const declaredType = variableTypes.get(key);
  if (declaredType) {
    return { kind: normalizeDeclaredType(declaredType) };
  }
  if (typeContext?.variables.has(key)) {
    const declaredStructType = typeContext.variables.get(key);
    return { kind: normalizeDeclaredType(declaredStructType) };
  }
  if (BUILTIN_IMPLICIT_IDENTIFIER_TYPES.has(key)) {
    const builtinType = BUILTIN_IMPLICIT_IDENTIFIER_TYPES.get(key);
    return { kind: normalizeDeclaredType(builtinType) };
  }
  const projectGlobalType = projectGlobalVariableIndexByVersion[version].get(key);
  if (projectGlobalType) {
    return { kind: normalizeDeclaredType(projectGlobalType) };
  }

  const coreEntry = getIndex(version).get(key);
  if (coreEntry?.kind === 'function') {
    return { kind: normalizeDeclaredType(coreEntry.returnType) };
  }
  if (coreEntry?.kind === 'constant') {
    return { kind: normalizeDeclaredType(coreEntry.returnType) };
  }
  if (userFunctionIndexByVersion[version].has(key)) {
    // Known user function/process symbol; avoid unresolved-identifier noise when seen in expressions.
    return { kind: 'unknown' };
  }

  // External/global constants often come from includes or sibling files and are commonly UPPER_CASE.
  // Treat them as non-blocking numeric-like values to avoid false type mismatches across files.
  if (/^[A-Z_][A-Z0-9_]*$/.test(identifier)) {
    return { kind: 'unknown' };
  }

  return { kind: 'unknown', unresolvedIdentifier: identifier };
}

function resolveArgumentType(
  argument: string,
  variableTypes: Map<string, string>,
  version: BennuVersion,
  typeContext?: DocumentTypeContext,
): ResolvedArgType {
  const trimmed = argument.trim();
  if (!trimmed) {
    return { kind: 'unknown' };
  }

  // Legacy Bennu code commonly uses 0 as NULL for optional string/pointer params
  // (e.g. exit(0,0)). Keep this strict to null-like zero literals only.
  if (/^[-+]?0+$/.test(trimmed) || /^0x0+$/i.test(trimmed) || /^0+h$/i.test(trimmed)) {
    return { kind: 'number', isNullLiteral: true };
  }

  // Bennu selector syntax used in APIs like collision(type mouse), signal(type Proc, ...), get_id(type Proc), etc.
  if (/^type\s+[A-Za-z_#][A-Za-z0-9_#]*$/i.test(trimmed)) {
    return { kind: 'number' };
  }

  const literal = inferLiteralType(trimmed);
  if (literal === 'string' || literal === 'number') {
    return { kind: literal };
  }

  const byReferenceMatch = trimmed.match(/^&\s*([A-Za-z_#][A-Za-z0-9_#]*)$/);
  if (byReferenceMatch) {
    return { kind: 'pointer' };
  }

  const compactExpression = trimmed.replace(/\s+/g, '');
  const memberAccessOnly = compactExpression.match(
    /^[A-Za-z_#][A-Za-z0-9_#]*(?:\[[^\]\r\n]*\])*(?:\.[A-Za-z_#][A-Za-z0-9_#]*(?:\[[^\]\r\n]*\])*)+$/,
  );
  if (memberAccessOnly && typeContext) {
    return resolveMemberAccessType(memberAccessOnly[0], variableTypes, typeContext);
  }

  const identifierOnly = trimmed.match(/^[A-Za-z_#][A-Za-z0-9_#]*$/);
  if (identifierOnly) {
    return resolveIdentifierType(identifierOnly[0], variableTypes, version, typeContext);
  }

  // Single-call expression (e.g. fpg_load("..."), sound_load("..."), myFunc(...)):
  // infer type from function return type regardless of inner argument syntax.
  const topLevelCallMatch = trimmed.match(/^([A-Za-z_#][A-Za-z0-9_#]*)\s*\(/);
  if (topLevelCallMatch) {
    const name = topLevelCallMatch[1];
    const openIndex = trimmed.indexOf('(');
    let depth = 0;
    let inString = false;
    let quote = '';
    let closingIndex = -1;

    for (let i = openIndex; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      const prev = i > 0 ? trimmed[i - 1] : '';
      if (inString) {
        if (ch === quote && prev !== '\\') {
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
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          closingIndex = i;
          break;
        }
      }
    }

    if (closingIndex > 0 && trimmed.slice(closingIndex + 1).trim().length === 0) {
      return resolveIdentifierType(name, variableTypes, version, typeContext);
    }
  }

  // Best-effort type inference for arithmetic expressions that include identifiers.
  if (/^[A-Za-z0-9_#\s+\-*/%().[\]]+$/.test(trimmed)) {
    let expressionForIdentifiers = trimmed;
    const unresolvedMemberAccesses: string[] = [];
    if (typeContext) {
      expressionForIdentifiers = expressionForIdentifiers.replace(
        INDEXED_MEMBER_ACCESS_PATTERN,
        (memberAccess) => {
          const resolved = resolveMemberAccessType(memberAccess, variableTypes, typeContext);
          if (resolved.unresolvedIdentifier) {
            unresolvedMemberAccesses.push(resolved.unresolvedIdentifier);
            return '0';
          }
          if (resolved.kind === 'string') {
            return '"s"';
          }
          return '0';
        },
      );
    }

    // Normalize Bennu process-type selector fragments (type ProcName) to numeric placeholders.
    expressionForIdentifiers = expressionForIdentifiers.replace(/\btype\s+[A-Za-z_#][A-Za-z0-9_#]*\b/gi, '0');

    if (unresolvedMemberAccesses.length > 0) {
      return { kind: 'unknown', unresolvedIdentifier: unresolvedMemberAccesses[0] };
    }

    const identifiers = [...expressionForIdentifiers.matchAll(/\b([A-Za-z_#][A-Za-z0-9_#]*)\b/g)]
      .map((match) => match[1])
      .filter((identifier) => !EXPRESSION_OPERATOR_KEYWORDS.has(identifier.toUpperCase()));
    if (identifiers.length === 0) {
      return { kind: 'number' };
    }
    const unresolved = identifiers
      .map((identifier) => resolveIdentifierType(identifier, variableTypes, version, typeContext))
      .find((entry) => entry.unresolvedIdentifier);
    if (unresolved) {
      return unresolved;
    }
    const allNumeric = identifiers.every((identifier) => {
      const resolved = resolveIdentifierType(identifier, variableTypes, version, typeContext);
      return resolved.kind === 'number';
    });
    if (allNumeric) {
      return { kind: 'number' };
    }
  }

  return { kind: 'unknown' };
}

function isLineCommentedOnly(line: string): boolean {
  return line.trim().startsWith('//');
}

function collectDeclaredVariableTypes(text: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const code = stripCommentsPreservingLength(text);
  const lines = code.split(/\r?\n/);
  const functionHeaderPattern =
    /(?:^|\n)\s*(?:(?:private|public|global|local)\s+)?(?:process|procedure|function\s+(?:(?:int|double|float|qword|dword|word|short|byte|string|pointer|variant)\s+)?)\s*[A-Za-z_#][A-Za-z0-9_#]*\s*\(([\s\S]*?)\)/gi;

  for (const match of code.matchAll(functionHeaderPattern)) {
    const paramsText = match[1] ?? '';
    const parsed = parseUserParams(paramsText);
    for (let i = 0; i < parsed.names.length; i += 1) {
      const name = parsed.names[i]?.trim();
      const type = parsed.types[i]?.trim().toLowerCase() ?? 'variant';
      if (!name || !/^[A-Za-z_#][A-Za-z0-9_#]*$/.test(name)) {
        continue;
      }
      declarations.set(name.toUpperCase(), type);
    }
  }

  for (const line of lines) {
    if (!line.trim() || isLineCommentedOnly(line)) {
      continue;
    }
    for (const match of line.matchAll(new RegExp(TYPED_DECLARATION_SEGMENT_PATTERN))) {
      const declaredType = (match[1] ?? '').toLowerCase();
      const rest = (match[2] ?? '').trim();
      if (!declaredType || !rest || rest.includes('(')) {
        continue;
      }
      const declarators = splitArguments(rest);
      for (const declarator of declarators) {
        const identifierMatch = declarator.match(/[A-Za-z_#][A-Za-z0-9_#]*/);
        if (!identifierMatch) {
          continue;
        }
        const identifier = identifierMatch[0];
        declarations.set(identifier.toUpperCase(), declaredType);
      }
    }
  }

  return declarations;
}

interface RoutineScopeContext {
  startOffset: number;
  endOffset: number;
  variableTypes: Map<string, string>;
}

function collectTypedDeclarationsFromCodeSegment(codeSegment: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const lines = codeSegment.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    for (const match of line.matchAll(new RegExp(TYPED_DECLARATION_SEGMENT_PATTERN))) {
      const declaredType = (match[1] ?? '').toLowerCase();
      const rest = (match[2] ?? '').trim();
      if (!declaredType || !rest || rest.includes('(')) {
        continue;
      }
      const declarators = splitArguments(rest);
      for (const declarator of declarators) {
        const identifierMatch = declarator.match(/[A-Za-z_#][A-Za-z0-9_#]*/);
        if (!identifierMatch) {
          continue;
        }
        declarations.set(identifierMatch[0].toUpperCase(), declaredType);
      }
    }
  }

  return declarations;
}

function collectRoutineScopeContexts(text: string): RoutineScopeContext[] {
  const contexts: RoutineScopeContext[] = [];
  const code = stripCommentsPreservingLength(text);
  const headerPattern =
    /(?:^|\n)\s*(?:(?:private|public|global|local)\s+)?(?:process|procedure|function\s+(?:(?:int|double|float|qword|dword|word|short|byte|string|pointer|variant)\s+)?)\s*[A-Za-z_#][A-Za-z0-9_#]*\s*\(([\s\S]*?)\)/gi;
  const headers: Array<{ startOffset: number; headerEndOffset: number; paramsText: string }> = [];

  for (const match of code.matchAll(headerPattern)) {
    const headerText = match[0] ?? '';
    const startOffset = match.index ?? 0;
    const headerEndOffset = startOffset + headerText.length;
    headers.push({
      startOffset,
      headerEndOffset,
      paramsText: match[1] ?? '',
    });
  }

  for (let i = 0; i < headers.length; i += 1) {
    const header = headers[i];
    const endOffset = i + 1 < headers.length ? headers[i + 1].startOffset : code.length;
    const variableTypes = new Map<string, string>();

    const params = parseUserParams(header.paramsText);
    for (let paramIndex = 0; paramIndex < params.names.length; paramIndex += 1) {
      const name = params.names[paramIndex]?.trim();
      const type = params.types[paramIndex]?.trim().toLowerCase() ?? 'variant';
      if (!name || !/^[A-Za-z_#][A-Za-z0-9_#]*$/.test(name)) {
        continue;
      }
      variableTypes.set(name.toUpperCase(), type);
    }

    const localDeclarations = collectTypedDeclarationsFromCodeSegment(code.slice(header.headerEndOffset, endOffset));
    for (const [name, declaredType] of localDeclarations.entries()) {
      variableTypes.set(name, declaredType);
    }

    contexts.push({
      startOffset: header.startOffset,
      endOffset,
      variableTypes,
    });
  }

  return contexts;
}

function variableTypesForOffset(
  globalVariableTypes: Map<string, string>,
  routineScopes: RoutineScopeContext[],
  offset: number,
): Map<string, string> {
  let scope: RoutineScopeContext | undefined;
  for (const entry of routineScopes) {
    if (offset < entry.startOffset) {
      break;
    }
    if (offset >= entry.startOffset && offset < entry.endOffset) {
      scope = entry;
    }
  }
  if (!scope || scope.variableTypes.size === 0) {
    return globalVariableTypes;
  }
  const merged = new Map(globalVariableTypes);
  for (const [name, declaredType] of scope.variableTypes.entries()) {
    merged.set(name, declaredType);
  }
  return merged;
}

function inferredTypeNameFromResolvedType(kind: ResolvedArgType['kind']): string | undefined {
  if (kind === 'number') {
    return 'int';
  }
  if (kind === 'string') {
    return 'string';
  }
  if (kind === 'pointer') {
    return 'pointer';
  }
  if (kind === 'variant') {
    return 'variant';
  }
  return undefined;
}

function shouldUpdateInferredType(existingType: string | undefined, nextType: string): boolean {
  if (!existingType) {
    return true;
  }
  const existing = normalizeDeclaredType(existingType);
  const incoming = normalizeDeclaredType(nextType);
  if (existing === 'unknown') {
    return true;
  }
  if (existing === incoming) {
    return false;
  }
  if (existing === 'number' && incoming === 'number') {
    return false;
  }
  return false;
}

function inferVariableTypesFromAssignments(
  text: string,
  seedTypes: Map<string, string>,
  version: BennuVersion,
  typeContext: DocumentTypeContext,
): Map<string, string> {
  const inferred = new Map(seedTypes);
  const code = stripCommentsPreservingLength(text);
  const lines = code.split(/\r?\n/);
  const assignmentPattern = /(?:^|;)\s*([A-Za-z_#][A-Za-z0-9_#]*)\s*=\s*([^;]+)(?=;|$)/g;

  // Iterate a few passes so `A = B; B = 123;` can eventually infer A as number too.
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || /^#/.test(line)) {
        continue;
      }

      for (const match of rawLine.matchAll(assignmentPattern)) {
        const lhs = match[1];
        const rhs = match[2].trim();
        if (!lhs || !rhs) {
          continue;
        }
        if (rhs.includes('==') || rhs.includes('!=') || rhs.includes('<=') || rhs.includes('>=')) {
          continue;
        }

        const resolved = resolveArgumentType(rhs, inferred, version, typeContext);
        const inferredType = inferredTypeNameFromResolvedType(resolved.kind);
        if (!inferredType) {
          continue;
        }

        const key = lhs.toUpperCase();
        const existing = inferred.get(key);
        if (shouldUpdateInferredType(existing, inferredType)) {
          inferred.set(key, inferredType);
          changed = true;
        }
      }
    }

    if (!changed) {
      break;
    }
  }

  return inferred;
}

interface DocumentMacroSignature {
  name: string;
  parameterNames: string[];
  parameterTypes: (string | undefined)[];
}

function canonicalExpectedType(typeName?: string): string | undefined {
  const type = (typeName ?? '').trim().toLowerCase();
  if (!type) {
    return undefined;
  }
  if (type === 'string' || type === 'pointer' || type === 'variant') {
    return type;
  }
  if (NUMERIC_TYPES.has(type)) {
    return type;
  }
  return undefined;
}

function mergeExpectedTypes(existing: string | undefined, incoming: string | undefined): string | undefined {
  if (!incoming) {
    return existing;
  }
  if (!existing || existing === incoming) {
    return incoming;
  }
  if (NUMERIC_TYPES.has(existing) && NUMERIC_TYPES.has(incoming)) {
    return 'int';
  }
  return existing;
}

function knownIdentifierExpectedType(
  identifier: string,
  variableTypes: Map<string, string>,
  index: Map<string, SymbolEntry>,
): string | undefined {
  const key = identifier.toUpperCase();
  const declaredType = canonicalExpectedType(variableTypes.get(key));
  if (declaredType) {
    return declaredType;
  }
  const coreEntry = index.get(key);
  if (coreEntry?.kind === 'constant') {
    return canonicalExpectedType(coreEntry.returnType);
  }
  return undefined;
}

function inferMacroParameterTypes(
  bodyText: string,
  parameterNames: string[],
  variableTypes: Map<string, string>,
  index: Map<string, SymbolEntry>,
): (string | undefined)[] {
  const inferred = new Array<string | undefined>(parameterNames.length).fill(undefined);
  if (!bodyText.trim() || parameterNames.length === 0) {
    return inferred;
  }

  const paramIndexByName = new Map<string, number>();
  for (let i = 0; i < parameterNames.length; i += 1) {
    paramIndexByName.set(parameterNames[i].toUpperCase(), i);
  }

  const body = stripCommentsPreservingLength(bodyText);

  const assignmentPattern = /\b([A-Za-z_#][A-Za-z0-9_#]*)\b\s*=\s*\b([A-Za-z_#][A-Za-z0-9_#]*)\b/g;
  for (const match of body.matchAll(assignmentPattern)) {
    const lhs = match[1];
    const rhs = match[2];

    const rhsParamIndex = paramIndexByName.get(rhs.toUpperCase());
    if (rhsParamIndex !== undefined) {
      const lhsType = knownIdentifierExpectedType(lhs, variableTypes, index);
      inferred[rhsParamIndex] = mergeExpectedTypes(inferred[rhsParamIndex], lhsType);
    }

    const lhsParamIndex = paramIndexByName.get(lhs.toUpperCase());
    if (lhsParamIndex !== undefined) {
      const rhsType = knownIdentifierExpectedType(rhs, variableTypes, index);
      inferred[lhsParamIndex] = mergeExpectedTypes(inferred[lhsParamIndex], rhsType);
    }
  }

  for (const call of extractCallMatches(body)) {
    const entry = index.get(call.name.toUpperCase());
    if (!entry || entry.kind !== 'function') {
      continue;
    }
    const args = splitArguments(call.args);
    if (args.length === 0) {
      continue;
    }
    const signatures = (entry.signatures.length > 0 ? entry.signatures : [entry.signature])
      .map((sig) => coreSignatureParamTypes(sig))
      .filter((sigTypes) => sigTypes.length === args.length);
    if (signatures.length === 0) {
      continue;
    }

    for (let argIndex = 0; argIndex < args.length; argIndex += 1) {
      const paramIndex = paramIndexByName.get(args[argIndex].trim().toUpperCase());
      if (paramIndex === undefined) {
        continue;
      }

      const candidateTypes = new Set<string>();
      for (const sig of signatures) {
        const expected = canonicalExpectedType(sig[argIndex]);
        if (expected) {
          candidateTypes.add(expected);
        }
      }

      if (candidateTypes.size === 1) {
        inferred[paramIndex] = mergeExpectedTypes(inferred[paramIndex], [...candidateTypes][0]);
        continue;
      }
      if (candidateTypes.size > 1) {
        const allNumeric = [...candidateTypes].every((type) => NUMERIC_TYPES.has(type));
        if (allNumeric) {
          inferred[paramIndex] = mergeExpectedTypes(inferred[paramIndex], 'int');
        }
      }
    }
  }

  return inferred;
}

function collectDocumentMacroSignatures(
  text: string,
  version: BennuVersion,
  variableTypes: Map<string, string>,
  index: Map<string, SymbolEntry>,
): Map<string, DocumentMacroSignature> {
  const macros = new Map<string, DocumentMacroSignature>();
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const declarationLine = stripDeclarationComments(lines[i]);
    const match = declarationLine.match(/^\s*#define\s+([A-Za-z_#][A-Za-z0-9_#]*)\s*\(([^)]*)\)(.*)$/i);
    if (!match) {
      continue;
    }

    const name = match[1];
    const parameterNames = splitArguments(match[2]).map((item) => item.trim()).filter((item) => item.length > 0);
    const bodySegments: string[] = [];

    const pushSegment = (segment: string) => {
      const withoutBackslash = segment.replace(/\\\s*$/, '').trim();
      if (withoutBackslash.length > 0) {
        bodySegments.push(withoutBackslash);
      }
    };

    pushSegment((match[3] ?? '').trim());

    while (lines[i].trimEnd().endsWith('\\') && i + 1 < lines.length) {
      i += 1;
      pushSegment(stripDeclarationComments(lines[i]));
    }

    const bodyText = bodySegments.join(' ');
    macros.set(name.toUpperCase(), {
      name,
      parameterNames,
      parameterTypes: inferMacroParameterTypes(bodyText, parameterNames, variableTypes, index),
    });
  }

  return macros;
}

function unresolvedArgumentIdentifiers(actualTypes: ResolvedArgType[]): string[] {
  return [...new Set(actualTypes.map((argType) => argType.unresolvedIdentifier).filter(Boolean) as string[])]
    .filter((identifier) => /[a-z]/.test(identifier));
}

function lineHasUnclosedOpenParen(line: string): boolean {
  const code = codeWithoutComments(line);
  let depth = 0;
  let inString = false;
  let quote = '';

  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    const prev = i > 0 ? code[i - 1] : '';

    if (inString) {
      if (ch === quote && prev !== '\\') {
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
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(depth - 1, 0);
    }
  }

  return depth > 0;
}

function parenDepthAtLineStart(lines: string[]): number[] {
  const depths: number[] = new Array(lines.length).fill(0);
  let depth = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    depths[lineIndex] = depth;
    const line = lines[lineIndex];
    let inString = false;
    let quote = '';

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      const prev = i > 0 ? line[i - 1] : '';

      if (inString) {
        if (ch === quote && prev !== '\\') {
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
        depth += 1;
      } else if (ch === ')') {
        depth = Math.max(depth - 1, 0);
      }
    }
  }

  return depths;
}

function collectMacroDefinitionLines(lines: string[]): Set<number> {
  const macroLines = new Set<number>();
  let insideMacro = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    const startsMacro = /^\s*#define\b/i.test(line);

    if (startsMacro) {
      insideMacro = true;
    }

    if (insideMacro) {
      macroLines.add(lineIndex);
      const continues = trimmed.endsWith('\\');
      if (!continues) {
        insideMacro = false;
      }
    }
  }

  return macroLines;
}

function hasSemicolonAfterCallOnSameLine(text: string, callEndOffset: number): boolean {
  let i = Math.max(callEndOffset, 0);
  while (i < text.length && text[i] !== '\n') {
    const ch = text[i];
    const next = text[i + 1] ?? '';
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === ';') {
      return true;
    }
    if (ch === '/' && (next === '/' || next === '*')) {
      return false;
    }
    return false;
  }
  return false;
}

function isStandaloneMultilineCall(text: string, match: CallMatch, lineStarts: number[]): boolean {
  const startPos = positionAtOffset(lineStarts, match.start);
  const endPos = positionAtOffset(lineStarts, Math.max(match.end - 1, match.start));
  if (endPos.line <= startPos.line) {
    return false;
  }
  const lineStartOffset = text.lastIndexOf('\n', Math.max(match.start - 1, 0)) + 1;
  const prefix = text.slice(lineStartOffset, match.start).trim();
  return prefix.length === 0;
}

function extractCallMatches(text: string): CallMatch[] {
  const matches: CallMatch[] = [];
  const code = stripCommentsPreservingLength(text);
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
        argsStart,
        argsEnd,
        start,
        end: i,
      });
    }
  }

  return matches;
}

function shouldSkipCallValidation(text: string, callStartOffset: number): boolean {
  const lineStart = text.lastIndexOf('\n', Math.max(callStartOffset - 1, 0)) + 1;
  const prefix = text.slice(lineStart, callStartOffset);

  if (/^\s*(?:declare\s+)?(?:(?:private|public|global|local)\s+)?(?:process|function|procedure)\s+$/i.test(prefix)) {
    return true;
  }
  if (/^\s*#define\s+$/i.test(prefix)) {
    return true;
  }
  return false;
}

function collectLiveDiagnostics(text: string, version: BennuVersion): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = text.split(/\r?\n/);
  const textWithoutComments = stripCommentsPreservingLength(text);
  const linesWithoutComments = textWithoutComments.split(/\r?\n/);
  const macroDefinitionLines = collectMacroDefinitionLines(linesWithoutComments);
  const parenDepthByLine = parenDepthAtLineStart(linesWithoutComments);
  const lineStarts = buildLineStarts(text);
  const index = getIndex(version);
  const userFunctions = userFunctionIndexByVersion[version];
  const typeContext = collectDocumentTypeContext(text);
  const declaredVariableTypes = collectDeclaredVariableTypes(text);
  const variableTypes = inferVariableTypesFromAssignments(text, declaredVariableTypes, version, typeContext);
  const routineScopes = collectRoutineScopeContexts(text);
  const macroSignatures = collectDocumentMacroSignatures(text, version, variableTypes, index);

  for (const [lineNumber, line] of lines.entries()) {
    const lineWithoutComments = linesWithoutComments[lineNumber] ?? '';
    const codeForTokens = codeForTokenDiagnostics(lineWithoutComments);
    const isMacroDefinitionLine = macroDefinitionLines.has(lineNumber);

    const invalidTokenPattern = /\b(?!0x[0-9a-f]+\b)(?![0-9a-f]+h\b)\d+[A-Za-z_][A-Za-z0-9_]*\b/gi;
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

    const trimmed = lineWithoutComments.trim();
    if (!trimmed) {
      continue;
    }
    if (isMacroDefinitionLine) {
      continue;
    }

    const lastSemicolon = lineWithoutComments.lastIndexOf(';');
    const trailingStatement = (lastSemicolon >= 0 ? lineWithoutComments.slice(lastSemicolon + 1) : lineWithoutComments).trim();
    if (!trailingStatement) {
      continue;
    }
    const insideParenthesizedContinuation = (parenDepthByLine[lineNumber] ?? 0) > 0;

    if (
      trailingStatement.endsWith(';') ||
      trailingStatement.endsWith(':') ||
      trailingStatement.endsWith('\\') ||
      trailingStatement.endsWith('(') ||
      trailingStatement.endsWith(',')
    ) {
      continue;
    }

    if (
      /^(#|program\b|import\b|include\b|declare\b|global\b|local\b|public\b|private\b|type\b|process\b|function\b|procedure\b|begin\b|end\b|else\b|elseif\b|if\b|for\b|while\b|loop\b|repeat\b|until\b|switch\b|case\b|default\b|break\b|return\b)/i.test(
        trimmed,
      ) ||
      /^(#|program\b|import\b|include\b|declare\b|global\b|local\b|public\b|private\b|type\b|process\b|function\b|procedure\b|begin\b|end\b|else\b|elseif\b|if\b|for\b|while\b|loop\b|repeat\b|until\b|switch\b|case\b|default\b|break\b|return\b)/i.test(
        trailingStatement,
      )
    ) {
      continue;
    }

    const hasCallLikeStatement = /\b[A-Za-z_#][A-Za-z0-9_#]*\s*\(/.test(trailingStatement);
    const hasAssignmentLikeStatement = /\b[A-Za-z_][A-Za-z0-9_#]*\s*(?:=(?!=)|[+\-*/%]=)/.test(trailingStatement);
    const callContinuesInNextLine = hasCallLikeStatement && lineHasUnclosedOpenParen(lineWithoutComments);

    if (!insideParenthesizedContinuation && !callContinuesInNextLine && (hasCallLikeStatement || hasAssignmentLikeStatement)) {
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: toRange(lineNumber, 0, Math.max(trimmed.length, 1)),
        source: 'bennugd',
        message: 'Possible missing semicolon `;` at end of statement.',
      });
    }
  }

  for (const match of extractCallMatches(text)) {
    if (shouldSkipCallValidation(text, match.start)) {
      continue;
    }
    const callStartLine = positionAtOffset(lineStarts, match.start).line;
    if (macroDefinitionLines.has(callStartLine)) {
      continue;
    }

    const callName = match.name.toUpperCase();
    const entry = index.get(callName);
    const userEntry = userFunctions.get(callName);
    const localMacro = macroSignatures.get(callName);
    const expectedArgsSet = new Set<number>();
    if (userEntry) {
      for (const arity of userEntry.arities) {
        expectedArgsSet.add(arity);
      }
    } else if (entry && entry.kind === 'function' && entry.signature) {
      for (const arity of signatureArities(entry)) {
        expectedArgsSet.add(arity);
      }
    }
    if (localMacro) {
      expectedArgsSet.add(localMacro.parameterNames.length);
    }
    const expectedArgs = [...expectedArgsSet];
    const displayName = localMacro?.name ?? userEntry?.name ?? entry?.name ?? match.name;
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
        range: rangeFromOffsets(lineStarts, match.start, match.end),
        source: 'bennugd',
        message: detailLines.join('\n'),
      });
      continue;
    }

    const candidateParamTypes: (string | undefined)[][] = [];
    if (localMacro && localMacro.parameterTypes.length === actualArgs.length) {
      candidateParamTypes.push(localMacro.parameterTypes);
    }
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

    const scopedVariableTypes = variableTypesForOffset(variableTypes, routineScopes, match.start);
    const actualTypes = actualArgs.map((arg) => resolveArgumentType(arg, scopedVariableTypes, version, typeContext));
    const unresolvedIdentifiers = unresolvedArgumentIdentifiers(actualTypes);
    if (unresolvedIdentifiers.length > 0) {
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: rangeFromOffsets(lineStarts, match.start, match.end),
        source: 'bennugd',
        message: `Unknown identifier(s) in arguments: ${unresolvedIdentifiers.join(', ')}.`,
      });
    }

    const hasCompatibleSignature = candidateParamTypes.some((paramTypes) =>
      paramTypes.every((expected, argIndex) => isTypeCompatible(expected, actualTypes[argIndex])));

    if (!hasCompatibleSignature) {
      const signatureHint = expectedSignaturesText(entry, userEntry);
      const descriptionHint = userEntry?.description || entry?.description;
      const unresolvedHint = unresolvedIdentifiers.length > 0 ? `Unresolved identifiers: ${unresolvedIdentifiers.join(', ')}` : undefined;
      const detailLines = [
        `${displayName} argument types do not match expected signature.`,
        signatureHint,
        unresolvedHint,
        descriptionHint ? `Description: ${descriptionHint}` : undefined,
      ].filter((line): line is string => Boolean(line));
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: rangeFromOffsets(lineStarts, match.start, match.end),
        source: 'bennugd',
        message: detailLines.join('\n'),
      });
    }

    if (isStandaloneMultilineCall(text, match, lineStarts) && !hasSemicolonAfterCallOnSameLine(text, match.end)) {
      const warningRange = rangeFromOffsets(lineStarts, Math.max(match.end - 1, match.start), match.end);
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: warningRange,
        source: 'bennugd',
        message: 'Possible missing semicolon `;` at end of multiline call statement.',
      });
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
      completionProvider: { triggerCharacters: ['_', '#', '.'] },
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
  const memberContext = memberAccessContextAt(text, offset);
  if (memberContext) {
    const typeContext = collectDocumentTypeContext(text);
    const variableType = typeContext.variables.get(memberContext.baseIdentifier.toUpperCase());
    const typeDefinition = variableType ? typeContext.types.get(variableType.toUpperCase()) : undefined;
    if (!typeDefinition) {
      return { isIncomplete: false, items: [] };
    }

    const memberPrefix = memberContext.memberPrefix.toUpperCase();
    const fieldItems = typeDefinition.fields
      .filter((field) => !memberPrefix || field.name.toUpperCase().startsWith(memberPrefix))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((field) => ({
        label: field.name,
        kind: CompletionItemKind.Field,
        detail: `${typeDefinition.name}.${field.name}: ${field.type}`,
        documentation: `Field \`${field.name}\` from type \`${typeDefinition.name}\` (\`${field.type}\`).`,
        insertText: field.name,
        sortText: `0_${field.name.toUpperCase()}`,
      }));

    return { isIncomplete: false, items: fieldItems };
  }

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
