# Changelog

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
