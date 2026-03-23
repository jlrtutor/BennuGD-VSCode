# Changelog

## 1.0.43 - 2026-03-23

- Fixed routine-scope parameter indexing for untyped params (e.g. `PROCESS tres(tipe)`), which are now treated as `variant` by default.
- Fixed false unresolved-identifier diagnostics for calls that pass untyped routine parameters (e.g. `get_treasure_loc(tipe)`).
- Applied the same default-`variant` behavior to declaration harvesting from routine headers for consistent inference.

## 1.0.42 - 2026-03-23

- Fixed member-access analysis to support indexed chains such as `the_map_grid[0].cord[a][b]` in argument expressions.
- Added normalization of indexed member paths (`obj[idx].field[idx] -> obj.field`) before type/member resolution.
- This removes false `Unknown identifier(s)` diagnostics in valid calls like `trail_blip(a,b,the_map_grid[0].cord[a][b]);`.

## 1.0.41 - 2026-03-23

- Fixed false type-mismatch diagnostics for APIs with optional string parameters when legacy Bennu code passes null-like zero literals (for example `exit(0,0)`).
- Added explicit null-literal recognition (`0`, `0x0...`, `0h...`) in argument inference and allowed only those null-like values to satisfy expected `string` parameters.
- Keeps strict string validation for non-null numeric values (for example `log(2)` still reports type mismatch).

## 1.0.40 - 2026-03-23

- Fixed expression token analysis to treat Bennu operator keywords (`mod`, `div`, `and`, `or`, `xor`, `not`) as operators instead of identifiers.
- This removes false unresolved/type-mismatch diagnostics in valid expressions such as `1000 - menuscroll mod 1800` used in calls like `zlDraw(...)`.
- Improved numeric-expression fallback when an expression only contains numeric literals/operators after normalization.

## 1.0.39 - 2026-03-23

- Fixed core export parsing for `FUNC(...)` entries whose implementation token is wrapped in macros (for example `DRWFN_COLOR(point)` in `libmod_gfx_exports.h`).
- This restores missing function variants in the LSP symbol index (for example `DRAW_POINT(III)`), removing false “expects 2 argument(s) but got 3” diagnostics in valid color draw calls.
- Added safer source-symbol extraction from macro/comment forms in export lines so descriptions and variants are indexed more reliably.

## 1.0.38 - 2026-03-23

- Added support for classic Bennu hex literals with trailing `h` (for example `0048h`, `00FCh`, `01FEh`, `03FFh`) in literal/type analysis and invalid-token filtering.
- Improved function-header parsing for typed return signatures (for example `FUNCTION Int Name(...)`), ensuring parameter types are recognized correctly in diagnostics.
- Fixed false unresolved/type-mismatch diagnostics in cases like `Map_Load(Gal_Ruta + Gal_Archivo)` where parameters from typed function headers were previously missed.

## 1.0.37 - 2026-03-23

- Added `.lib` support to project source scanning (definitions, user signatures, macros, and global typed-variable indexing), so imported library globals are recognized in diagnostics.
- Fixed false unresolved/type-mismatch diagnostics for symbols declared in `.lib` files, such as `jkeys_state` from `jkeys.lib` used in `zomg.prg`.
- Hardened typed-declaration extraction by using fresh regex instances per line scan to avoid missed declarations in long files.

## 1.0.36 - 2026-03-23

- Improved typed-declaration parsing to support multiple same-line declarations separated by semicolons (for example `int L_money; int l_vidas;`) across project/global and local/scope indexes.
- Fixed false unresolved diagnostics caused by missing symbols from those split declarations (for example `l_vidas` in `write_var(...)`).
- Relaxed process member-access validation for project-specific runtime fields on process instances (for example `father.altura`) to avoid false unresolved member errors in expressions.

## 1.0.35 - 2026-03-23

- Improved assignment-based type inference for variables initialized from single function calls with complex arguments (including string literals), such as `gscore = fpg_load("data1/gscore.gdg");`.
- This prevents false unresolved/type-mismatch diagnostics in later calls where those inferred variables are used as typed arguments (for example `Objeto_extra(..., gscore, ...)`).

## 1.0.34 - 2026-03-23

- Fixed false “Invalid token ... identifiers cannot start with a digit” diagnostics on valid hexadecimal literals (for example `0xfce888ff`, `0x4040fcff`).
- Numeric-token validation now excludes hex-number patterns while still flagging invalid identifiers like `16BITS`.

## 1.0.33 - 2026-03-23

- Fixed false diagnostics on `declare process/function/procedure` headers:
  - no more invalid “missing semicolon” warnings on declaration lines
  - declaration headers are excluded from call-argument validation
- Improved user-parameter parsing to support grouped typed declarations like `double x,y` and `int file,graph,z`.

## 1.0.32 - 2026-03-23

- Added project-level global variable indexing (top-level typed declarations in `.prg/.inc`) so symbols declared in other files are recognized in current-file diagnostics.
- Fixed false unresolved/type-mismatch diagnostics in cross-file usages such as `sound_play(soundEffectEnemyAppears, 0)` where `soundEffectEnemyAppears` is declared globally in another module (e.g. `antiriad.prg`).

## 1.0.31 - 2026-03-23

- Fixed cross-file constant handling in type validation: unresolved `UPPER_CASE` identifiers (typical game constants from includes/other modules, such as `HURT_GHOST`) are now treated as non-blocking scalar values instead of hard unresolved identifiers.
- This removes false argument-type mismatches in calls like `checkCollisionWithPlayer(collision(type player), HURT_GHOST, true)` when constants are declared outside the current file.

## 1.0.30 - 2026-03-23

- Fixed boolean literal inference in argument type checks: `true`/`false` are now treated as numeric-compatible values (Bennu-style), avoiding false unresolved/type-mismatch diagnostics in calls such as `checkCollisionWithPlayer(..., true)`.

## 1.0.29 - 2026-03-23

- Fixed false unresolved/type-mismatch diagnostics for member-access expressions whose base symbol is external (for example globals coming from includes/modules), such as `enemyObject.posX` inside `interpolateX(...)`.
- Unknown member base identifiers are now treated as non-blocking `unknown` (instead of hard unresolved) while preserving unresolved diagnostics for invalid fields on known typed structures.

## 1.0.28 - 2026-03-23

- Fixed false unresolved/type-mismatch diagnostics for implicit process identifiers (for example `file`, `graph`, `x`, `y`, `region`, `id`, etc.) when used as plain arguments in calls like `graphic_info(file, graph, G_WIDTH)`.
- Improved expression inference to accept indexed expressions with square brackets (`[]`), so assignments such as `graph = framesAnimation[index]` contribute better type information.

## 1.0.27 - 2026-03-23

- Fixed scope-aware argument type validation inside `process/function/procedure` bodies by prioritizing routine parameter/local typed declarations over document-global name collisions.
- This resolves false positives like `scroll_start(0, fpgScreens, foregroundGraphic, backgroundGraphic, mainScreenRegion.id, mode);` where routine parameters were previously mis-typed by unrelated declarations in other scopes.

## 1.0.26 - 2026-03-23

- Added Bennu process-type selector support in expression analysis: `type <ProcessName>` is now treated as a valid numeric argument (e.g. `collision(type mouse)`, `signal(type Enemy, ...)`, `get_id(type Proc)`), based on BennuGD v1 usage patterns documented in Osk manual/examples.

## 1.0.25 - 2026-03-23

- Added parameter type harvesting from `process/function/procedure` headers (including multiline headers), so typed parameters are recognized as valid identifiers in argument type analysis.

## 1.0.24 - 2026-03-23

- Fixed false missing-semicolon warning on single-line `for(...)` headers by ensuring control-flow headers are excluded before trailing-segment statement checks.

## 1.0.23 - 2026-03-23

- Fixed false missing-semicolon diagnostics when a line contains multiple statements and the trailing segment after the last `;` is a control keyword (e.g. `...; end` in `case` blocks).

## 1.0.22 - 2026-03-23

- Fixed literal type detection so function calls containing string literals (e.g. `getScreenConnection("RIGHT")`) are no longer incorrectly classified as `string` arguments.

## 1.0.21 - 2026-03-23

- Added builtin `background` process-like symbol support for member access typing (`background.file`, `background.graph`, etc.).
- Excluded multiline `#define` body lines from statement-level semicolon diagnostics and call validation to avoid false positives in macro implementations.

## 1.0.20 - 2026-03-23

- Added intrinsic numeric symbol handling for `sizeof(...)` in expression type analysis, avoiding false unknown-identifier/type-mismatch diagnostics in calls like `memcopy(..., sizeof(...))`.

## 1.0.19 - 2026-03-23

- Improved missing-semicolon diagnostics for multiline control-flow conditions (`if`, `elseif`, `while`, `for`, etc.) by skipping statement-level `;` checks on lines that are inside an open parenthesized continuation.

## 1.0.18 - 2026-03-23

- Fixed false missing-semicolon warnings in multiline boolean/control expressions by distinguishing assignment operators from comparison operators (`==`, `!=`, `<=`, `>=`).

## 1.0.17 - 2026-03-23

- Added member-access type inference in argument analysis (e.g. `ruta.campo`, `father.file`) by resolving field types from `Type ... End` definitions.
- Added built-in process member model (`father`, `son`, `myself`) so common fields like `file`, `graph`, `x`, `y`, `priority`, etc. contribute typed inference.
- Improved expression analysis by replacing resolved member-access chains before identifier checks, reducing false unknown-identifier/type-mismatch diagnostics.

## 1.0.16 - 2026-03-23

- Fixed expression type analysis so known function symbols used inside arguments (e.g. `getRealX(x)`) are no longer reported as unknown identifiers.
- Core function symbols referenced in expressions now contribute their declared return type to inference.

## 1.0.15 - 2026-03-23

- Added variable type inference from assignments (for example, `GRAPH_X = 201;` inferred as numeric), improving argument type validation when symbols are not explicitly declared with a type.

## 1.0.14 - 2026-03-23

- Fixed live semicolon diagnostics inside multiline block comments (`/* ... */`) by fully excluding block-comment text from per-line statement checks.

## 1.0.13 - 2026-03-23

- Added member autocompletion for user-defined `Type` structures: writing `variable.` now suggests that structure's fields from the current document.

## 1.0.12 - 2026-03-23

- Fixed false missing-semicolon warning on call lines that are intentionally continued to next line (unclosed `(` on current line).

## 1.0.11 - 2026-03-23

- Added explicit semicolon validation for standalone multiline call statements (warns when closing `)` has no trailing `;`).

## 1.0.10 - 2026-03-23

- Fixed false missing-semicolon warning on multiline calls (lines ending with `(` or `,`).
- Added unresolved argument identifier diagnostics (for example, `blablabla` when not declared).
- Added local macro parameter type inference from macro body usage (assignments and core function calls), improving checks for wrappers like `set_modeX(w, h)`.

## 1.0.9 - 2026-03-23

- Improved live call diagnostics to correctly validate multiline calls (arguments across several lines).
- Added stronger argument type resolution using declared variable types and known constants.
- Added unresolved identifier feedback in signature/type mismatch diagnostics.
- Prevented false positives by skipping call validation on declaration lines (`function/process/procedure`) and `#define` declarations.

## 1.0.8 - 2026-03-23

- Added live diagnostic for probable missing semicolon (`;`) at end of statement lines (calls/assignments).

## 1.0.7 - 2026-03-23

- Improved call diagnostics for all known calls (core functions, user-defined functions/processes, and `#define` macros with parameters).
- Added argument arity validation with clearer messages and expected signatures.
- Added basic literal type validation (`string` vs `number`) for signature matching.
- Added local symbol priority over core symbols when names collide (hover, diagnostics, signature help, completion, and go-to-definition).
- Improved hover resolution accuracy (including CRLF position handling).
- Added richer hover details:
  - typed parameter list
  - parameter order and remaining parameter count
  - function description when available
- Added richer signature help while typing inside `(...)`:
  - active parameter highlighting
  - parameter type and name
  - position and remaining parameter guidance
- Added indexing support for project macros declared as `#define NAME(...)`.
- Rebuilds symbol index on save for `.prg`, `.inc`, `.h`, and `.c` files to keep analysis in sync without restarting.
- Updated extension/package references and install docs to version `1.0.7`.

## 1.0.0

- Initial release.
- BennuGD v1 and v2 syntax highlighting.
- LSP completion, hover, and symbol indexing.
- Compile and compile-and-run commands with configurable compiler/runtime paths.
