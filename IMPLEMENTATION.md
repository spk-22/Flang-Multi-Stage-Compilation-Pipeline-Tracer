# Implementation Details – flang‑ir‑tracer

---

## 1. Overview

The **flang‑ir‑tracer** uses the `FlangDriver` class (`flang_tracer/driver.py`) to invoke the `flang-new` binary for each compilation stage. For each Fortran source file it sequentially dumps:

| Stage             | Flang Flag(s)                                                    | Output Format           |
|-------------------|------------------------------------------------------------------|-------------------------|
| **Parse Tree**    | `-fc1 -fdebug-dump-parse-tree`                                   | Indented text tree      |
| **Symbols**       | `-fc1 -fget-symbols-sources`                                     | Plain text symbol list  |
| **FIR**           | `-fc1 -emit-fir -mmlir --mlir-print-debuginfo -o -`              | MLIR dialect text       |
| **HLFIR**         | `-fc1 -emit-hlfir -mmlir --mlir-print-debuginfo -o -`            | MLIR dialect text       |
| **LLVM IR**       | `-S -emit-llvm -g -O{level} -o -`                                | LLVM IR text            |

The server is launched using:
```bash
uvicorn flang_tracer.server:app --host 0.0.0.0 --port 8000
```

---

## 2. FlangDriver (`driver.py`)

### 2.1 Cross-Platform WSL Support

On Windows (`sys.platform == 'win32'`), all `flang-new` invocations are automatically prefixed with `wsl`:

```python
if use_wsl:
    input_path = to_wsl_path(input_file)  # D:\... → /mnt/d/...
    cmd = ["wsl", flang_exe] + stage_flags + [input_path]
else:
    cmd = [flang_exe] + stage_flags + [input_path]
```

`to_wsl_path()` translates Windows drive paths (e.g. `D:\cd_lab_el\new_folder`) to WSL mount paths (e.g. `/mnt/d/cd_lab_el/new_folder`).

### 2.2 Special Coarray Handling

When the input filename contains `coarray`, the driver automatically appends `-fcoarray` to the flag list. This was required by `06_coarray.f90` which uses Fortran coarray syntax (`integer :: A[*]`).

### 2.3 Timing and Memory Capture

```python
start_time = time.perf_counter()
result = subprocess.run(cmd, capture_output=True, text=True, check=True)
elapsed = time.perf_counter() - start_time

# Memory (Linux/WSL only — returns 0 on Windows host)
import resource
mem_kb = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
```

Timing results observed in the testcases (at O0):
- Fastest: `08_elemental.f90` HLFIR — 42.55 ms
- Slowest: `05_poly_dispatch.f90` FIR — 57.41 ms

### 2.4 Runtime Binary Profiling

`run_binary()` compiles the source to a temporary binary (`/tmp/temp_bin_{uuid}` on WSL), executes it, captures `stdout`, and measures compile + run time:

```python
compile_cmd = ["wsl", flang_exe, f"-{self.opt_level}", input_path, "-o", temp_bin_path]
run_cmd = ["wsl", temp_bin_path]
```

Results from testcases (at O0):
| Testcase              | Compile (ms) | Run (ms) | stdout               |
|-----------------------|-------------|----------|----------------------|
| `01_array_assign.f90` | 4449        | 1.25     | `3. 300.`            |
| `05_poly_dispatch.f90`| 4890        | 1.85     | `Area:  100.`        |
| `08_elemental.f90`    | 4060        | 0.95     | `1. 2. 3. 4. 5.`     |
| `11_error_example.f90`| *(error)*   | *(n/a)*  | Compiler error caught|

---

## 3. Compilation Stage Hooks (`flang_tracer/hooks/`)

Each hook class wraps a specific stage's raw compiler output and exposes `extract_fragment(source_range)`:

### `parse_hook.py` — ParseTreeParser
Builds a tree of `Node(content, children)` objects by parsing indentation levels in the `-fdebug-dump-parse-tree` output. Tested on all 10 valid testcases — produces correctly nested trees visible in the D3 visualiser.

### `sema_hook.py` — SemaExtractor
Parses `source_file:line:col` lines from `-fget-symbols-sources`. For `01_array_assign.f90`, this returns resolved names for `A`, `B`, `C`, `N`, and `i` with their declaration lines.

### `fir_hook.py` — FIRExtractor
Searches MLIR location annotations (`loc("file":line:col)`) to extract FIR instruction blocks corresponding to the requested source range. For `01_array_assign.f90` line 16 (`A(:) = B(:) + C(:)`), this returns the `hlfir.assign` and surrounding loop ops.

### `hlfir_hook.py` — HLFIRExtractor
Identical structure to `fir_hook.py` but applied to the `-emit-hlfir` output. Produces the high-level representation before FIR lowering flattens shape metadata.

### `llvmir_hook.py` — LLVMIRHook
Parses `!DILocation(line: N, ...)` annotations in the LLVM IR `--debuginfo` output. For `05_poly_dispatch.f90` line 43 (`a = s%area()`), this extracts ~32 lines of dispatch LLVM IR including the v-table load and indirect call.

---

## 4. Correlator (`flang_tracer/correlator/`)

### `mapping_engine.py` — MappingEngine
The `MappingEngine` receives the raw source, HLFIR, FIR, and LLVM IR texts and generates two tables:

1. **Cross-Stage Mapping**: Aligns each source line with its corresponding HLFIR / FIR / LLVM IR operation by matching `loc(...)` and `!DILocation` line numbers.
2. **Static Comparison Reference**: A side-by-side reference table comparing operation counts and patterns across stages.

These tables are sent as a `{"type": "mapping"}` WebSocket event after all five stages complete.

### `ir_stats.py` — IRStats
Counts categorized operations per stage:

| Category    | FIR/HLFIR Pattern          | LLVM IR Pattern         |
|-------------|---------------------------|-------------------------|
| Load        | `fir.load`, `hlfir.load`  | `load `                 |
| Store       | `fir.store`, `hlfir.assign`| `store `               |
| Arithmetic  | `arith.*`, `math.*`       | `icmp`, `fcmp`, `add`, `sub`, `mul` |
| Memory      | `fir.alloca`, `fir.allocmem`| `alloca `              |
| Control     | `fir.br`, `fir.cond_br`   | `br `, `ret `           |
| Calls       | `fir.call`, `hlfir.call`  | `call `                 |

Observed total IR op counts (whole-file LLVM IR):
- `08_elemental.f90`: **147** (lowest — intrinsic vectorised)
- `05_poly_dispatch.f90`: **212** (highest — v-table dispatch overhead)

### `matcher.py` — FuzzyMatcher
`score_match(source, ir_text)` produces a similarity score (0.0–1.0) between the Fortran source fragment and the corresponding IR text. Higher scores indicate tighter source-to-IR correspondence. Used to sort and filter fragments when multiple IR blocks match a source range.

### `graph.py` — TraceGraph
Builds a structured dict representation of all stage fragments, scores, and durations:
```python
graph.add_fragment(stage="fir", frag=frag, score=0.87, duration_ms=52.34)
```
This is consumed by the CLI renderers (text, JSON, HTML, dashboard) and returned via `graph.to_dict()`.

### `loc_index.py` — LocationIndex
An in-memory store mapping stage names → list of `Fragment` objects. Supports `get_by_stage(stage)` for O(1) lookup when correlating multiple stages.

---

## 5. FastAPI Server (`server.py`)

### WebSocket Endpoint: `/ws/trace`

The WebSocket handler processes requests in this order:
1. Receives JSON config: `{file, opt_level, diff_opt, line, end_line, flang}`
2. Resolves the `.f90` file path relative to the repo root
3. For each of the 5 stages (+ optional O3 diff stage): runs `driver.run_stage()`, extracts fragment, computes IRStats, sends `{"type": "result", ...}` event
4. Sends `{"type": "mapping", ...}` from `MappingEngine`
5. Runs `driver.run_binary()`, sends `{"type": "runtime", ...}`
6. Sends `{"type": "complete"}`

**Error Handling Observed**: For `11_error_example.f90`, `flang-new` returns non-zero, `run_stage()` returns `("", elapsed, 0)`, and the server sends `{"type": "error", "stage": "parse_tree", "message": "No output from Flang for this stage"}`.

### REST Endpoint: `GET /api/examples`
Walks the project tree (excluding `.venv`, `.git`, `__pycache__`) and returns all `.f90` files. This populates the file selector dropdown in the dashboard. With 11 testcase files, the endpoint returns a sorted list of 11 relative paths.

### Static Files: `/static`
Serves the frontend assets from `flang_tracer/static/`:
- `index.html` — dashboard layout
- `style.css` — dark-mode glassmorphic styling
- `app.js` — D3.js, Chart.js, WebSocket client, diff engine

---

## 6. Frontend (`flang_tracer/static/`)

### D3.js Parse Tree
The collapsible tree is built from the `ast_json` payload (included in the parse_tree stage result). For `01_array_assign.f90`, the tree has ~40 nodes; for `05_poly_dispatch.f90` it has ~120 nodes due to the class module and abstract interface declarations.

Single-child chains are collapsed into `Parent -> Child -> Grandchild` labels, reducing visual clutter.

### Chart.js Runtime Analytics (Logarithmic Scale)
Compile times range from ~4060 ms (`08_elemental.f90` O0) to ~5320 ms (`05_poly_dispatch.f90` O3). Runtime times range from 0.58 ms to 1.85 ms. The logarithmic y-axis (0.1–10000) makes both metrics simultaneously visible.

### IR Diff Analyzer
A client-side Myers-LCS diff compares LLVM IR at O0 vs O3 when `--diff-opt` is enabled. For `01_array_assign.f90`, the O3 diff shows ~15 lines added (vectorisation intrinsics like `llvm.x86.avx2.psrl.w`) and ~8 lines removed (redundant `alloca`/`store` pairs).

---

## 7. Extensibility

The modular design allows additional stages to be added by:
1. Creating a new hook class in `flang_tracer/hooks/` implementing `extract_fragment(SourceRange)`
2. Adding the stage tuple to the `stages` list in `server.py`
3. Updating `IRStats.count_ops()` with stage-specific operation patterns

Example: Adding a **Semantic FIR** stage (between symbols and FIR) would require only a new hook file and a one-line addition to the server stages list.
