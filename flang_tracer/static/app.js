let ws = null;
let timeChart = null;
let memoryChart = null;
let iopsChart = null;
let stageData = {};
let runtimeData = null;
let runtimeCompChart = null;

let parseTreeRoot = null;
let parseTreeZoom = null;
let parseTreeSvg = null;
let tokenIdCounter = 1;

const staticIRInfo = [
  { stage: 'Parse Tree', representation_type: 'AST-like Tree', purpose: 'Source structure representation', human_readability: 'High', optimization_capability: 'None', key_operations: 'Syntax validation, structure mapping', role: 'Initial compilation step' },
  { stage: 'Semantic Analysis', representation_type: 'Symbol Table & Typed AST', purpose: 'Type checking & resolution', human_readability: 'Medium', optimization_capability: 'None', key_operations: 'Symbol resolution, typing', role: 'Ensures program correctness' },
  { stage: 'HLFIR', representation_type: 'High-Level FIR (MLIR)', purpose: 'Fortran-specific high level constructs', human_readability: 'Medium-High', optimization_capability: 'High (Fortran-specific)', key_operations: 'Array assignments, intrinsics', role: 'Preserve Fortran semantics' },
  { stage: 'FIR', representation_type: 'Fortran IR (MLIR)', purpose: 'Lowered control flow & memory', human_readability: 'Medium-Low', optimization_capability: 'High (Memory/Loop)', key_operations: 'Memory alloc, CFG', role: 'Bridge to LLVM IR' },
  { stage: 'LLVM IR', representation_type: 'LLVM IR', purpose: 'Target-independent assembly', human_readability: 'Low', optimization_capability: 'Very High', key_operations: 'Register allocation, vectorization', role: 'Final optimization before backend' }
];

/* ── Lowering Patterns Knowledge Base ── */
const LOWERING_PATTERNS = [
    {
        construct: 'Variable Declaration',
        from: 'Fortran Source',
        to: 'FIR / LLVM IR',
        description: 'INTEGER, REAL, CHARACTER variables are lowered to fir.alloca (stack allocation) in FIR, then to LLVM alloca instructions. Array declarations become fir.alloca with shape operands.',
        example: 'INTEGER :: x  →  %0 = fir.alloca i32  →  %x = alloca i32, align 4'
    },
    {
        construct: 'Array Assignment',
        from: 'HLFIR',
        to: 'FIR',
        description: 'hlfir.assign with array operands is lowered to a loop nest in FIR. The HLFIR preserves the whole-array semantics (e.g., a = b + c) while FIR generates explicit DO loops with fir.do_loop, element-wise load/store, and index calculations.',
        example: 'hlfir.assign %rhs to %lhs  →  fir.do_loop %i = 1 to %n { fir.coordinate_of ... ; fir.store ... }'
    },
    {
        construct: 'DO Loop',
        from: 'FIR',
        to: 'LLVM IR',
        description: 'fir.do_loop is lowered to LLVM branch-based loop structure with a header block (entry + condition), body block, and latch block. Loop induction variable becomes a PHI node. With -O2+, loops may be vectorized.',
        example: 'fir.do_loop %i = %lb to %ub  →  br label %loop.header\\n%loop.header: %i = phi ...\\n  br i1 %cond, label %loop.body, label %loop.exit'
    },
    {
        construct: 'IF / ELSE',
        from: 'FIR',
        to: 'LLVM IR',
        description: 'fir.if (with optional else region) is lowered to LLVM conditional branches (br i1). Each branch becomes a separate basic block. Nested IF chains produce cascading branch blocks.',
        example: 'fir.if %cond { ... } else { ... }  →  br i1 %cond, label %then, label %else'
    },
    {
        construct: 'PRINT / WRITE',
        from: 'FIR',
        to: 'LLVM IR',
        description: 'Fortran I/O statements are lowered to runtime library calls. PRINT * becomes a sequence: _FortranAioBeginExternalListOutput, _FortranAioOutput* (type-specific), _FortranAioEndIoStatement. These are Flang runtime entry points.',
        example: 'PRINT *, x  →  call @_FortranAioBeginExternalListOutput(...)\\ncall @_FortranAioOutputInteger32(...)'
    },
    {
        construct: 'SUBROUTINE / FUNCTION Call',
        from: 'HLFIR',
        to: 'LLVM IR',
        description: 'fir.call lowers Fortran CALL statements. Arguments passed by reference use fir.ref<>, which becomes LLVM pointer arguments. INTENT(IN) scalars may be passed by value at -O2+.',
        example: 'fir.call @_QPmy_sub(%arg)  →  call void @my_sub_(ptr %arg)'
    },
    {
        construct: 'ALLOCATE / DEALLOCATE',
        from: 'FIR',
        to: 'LLVM IR',
        description: 'Dynamic allocation (ALLOCATE) becomes fir.allocmem, lowered to malloc via _FortranAAllocate runtime. DEALLOCATE becomes _FortranADeallocate. Descriptor-based arrays use the Fortran runtime allocator rather than raw malloc.',
        example: 'fir.allocmem !fir.array<?xi32>  →  call ptr @_FortranAAllocate(...)'
    },
    {
        construct: 'Module / USE Statement',
        from: 'Semantic',
        to: 'FIR',
        description: 'USE statements are resolved during semantic analysis (symbol table lookup). Module variables become fir.global (global variables) in FIR, accessed via fir.address_of. Module procedures become regular fir.func definitions.',
        example: 'USE my_mod, ONLY: val  →  fir.address_of(@_QMmy_modEval) : !fir.ref<i32>'
    },
    {
        construct: 'SELECT TYPE / CLASS',
        from: 'HLFIR',
        to: 'LLVM IR',
        description: 'Polymorphic dispatch (SELECT TYPE) is lowered through type descriptor comparisons. The runtime checks the dynamic type stored in the descriptor against each TYPE IS / CLASS IS branch, generating a chain of conditional branches.',
        example: 'SELECT TYPE(obj)  →  %type_id = load ... ; icmp eq %type_id, <constant> ; br i1 ...'
    },
    {
        construct: 'Implicit DO (Array Constructor)',
        from: 'HLFIR',
        to: 'FIR',
        description: 'Array constructors with implied DO loops (e.g., (/ (i, i=1,n) /)) are lowered from a single hlfir.elemental operation to explicit fir.do_loop with runtime-sized temporary allocation and element-wise stores.',
        example: '(/ (i**2, i=1,n) /)  →  fir.allocmem + fir.do_loop + fir.store'
    }
];

document.addEventListener('DOMContentLoaded', () => {
    initChart();
    fetchExamples();
    initTabs();
    initParseTreeToggle();
    
    document.getElementById('run-btn').addEventListener('click', startTrace);
    document.getElementById('export-json').addEventListener('click', exportJSON);
    document.getElementById('export-html').addEventListener('click', exportHTML);
    
    const runDiffBtn = document.getElementById('run-diff-btn');
    if (runDiffBtn) {
        runDiffBtn.addEventListener('click', runDiffAnalysis);
    }
    
    const rtRunBtn = document.querySelector('.rt-run-btn');
    if (rtRunBtn) {
        rtRunBtn.addEventListener('click', startTrace);
    }
    
    const searchInput = document.getElementById('ir-search');
    if (searchInput) {
        searchInput.addEventListener('input', populateStaticIRTable);
    }
    
    const optSelect = document.getElementById('opt-select');
    if (optSelect) {
        optSelect.addEventListener('change', updateLLVMOptBadge);
    }
    updateLLVMOptBadge();
    
    setupTableSorting();
    populateStaticIRTable();
});

/* ── Tab Switching ── */
function initTabs() {
    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;
            
            // Hide all tab panels
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
            // Show active
            document.getElementById(tabId).classList.remove('hidden');
            
            // Toggle active class on buttons
            buttons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Handle specialized rendering for active tabs
            if (tabId === 'tab-performance') {
                renderLoweringGraph();
                renderLoweringDocs();
                // Force chart resize after tab becomes visible
                setTimeout(() => {
                    if (timeChart) timeChart.resize();
                    if (memoryChart) memoryChart.resize();
                    if (iopsChart) iopsChart.resize();
                }, 50);
            } else if (tabId === 'tab-comparison') {
                renderDynamicMappingTable();
                populateStaticIRTable();
            } else if (tabId === 'tab-parsetree') {
                const graphView = document.getElementById('parse-tree-container');
                if (graphView && !graphView.classList.contains('hidden')) {
                    renderParseTreeGraph();
                } else {
                    renderParseTreeText();
                }
            } else if (tabId === 'tab-diff') {
                runDiffAnalysis();
            } else if (tabId === 'tab-heatmaps') {
                renderHeatmaps();
            } else if (tabId === 'tab-timeline') {
                renderTimeline();
            } else if (tabId === 'tab-runtime') {
                renderRuntimeTab();
            }
        });
    });
}

/* ── Parse Tree View Toggle ── */
function initParseTreeToggle() {
    const btnText = document.getElementById('btn-text-view');
    const btnGraph = document.getElementById('btn-graph-view');
    const btnSearch = document.getElementById('btn-search-tree');
    const textView = document.getElementById('parse-tree-output');
    const graphView = document.getElementById('parse-tree-container');
    const searchBar = document.getElementById('parse-tree-search-bar');
    const searchInput = document.getElementById('parse-tree-search-input');

    if (btnText) {
        btnText.addEventListener('click', () => {
            btnText.classList.add('active');
            btnGraph.classList.remove('active');
            textView.classList.remove('hidden');
            graphView.classList.add('hidden');
            renderParseTreeText();
        });
    }

    if (btnGraph) {
        btnGraph.addEventListener('click', () => {
            btnGraph.classList.add('active');
            btnText.classList.remove('active');
            graphView.classList.remove('hidden');
            textView.classList.add('hidden');
            renderParseTreeGraph();
        });
    }

    if (btnSearch) {
        btnSearch.addEventListener('click', () => {
            searchBar.classList.toggle('hidden');
            if (!searchBar.classList.contains('hidden')) {
                searchInput.focus();
            }
        });
    }

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            const term = searchInput.value.trim().toLowerCase();
            const countEl = document.getElementById('parse-tree-search-count');

            // Search in graph view (D3 nodes)
            const graphVisible = graphView && !graphView.classList.contains('hidden');
            if (graphVisible && parseTreeRoot) {
                let matchCount = 0;
                parseTreeRoot.each(d => {
                    d.matched = term && d.data.name.toLowerCase().includes(term);
                    if (d.matched) matchCount++;
                });
                if (countEl) countEl.textContent = term ? `${matchCount} match${matchCount !== 1 ? 'es' : ''}` : '';
                // Re-render the graph with highlights
                renderParseTreeGraph();
            }

            // Search in text view (highlight matches)
            const textVisible = textView && !textView.classList.contains('hidden');
            if (textVisible) {
                const fullTreeText = stageData && stageData.parse_tree && stageData.parse_tree.full_tree;
                if (fullTreeText && term) {
                    let html = escapeHTML(fullTreeText);
                    const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
                    let matchCount = 0;
                    html = html.replace(regex, (m) => { matchCount++; return `<span style="background:#f59e0b;color:#0b0f19;border-radius:2px;padding:0 2px;font-weight:700;">${m}</span>`; });
                    if (countEl) countEl.textContent = `${matchCount} match${matchCount !== 1 ? 'es' : ''}`;
                    textView.innerHTML = html;
                } else {
                    if (countEl) countEl.textContent = '';
                    renderParseTreeText();
                }
            }
        });
    }
}

/* ── Export ── */
function exportJSON() {
    const blob = new Blob([JSON.stringify(stageData, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'flang_trace_results.json';
    a.click();
    URL.revokeObjectURL(url);
}

function exportHTML() {
    const mappingTable = document.getElementById('ir-mapping-table').innerHTML || '<p>No data</p>';
    const refTable = document.getElementById('ir-static-reference-table').innerHTML || '<p>No data</p>';
    
    let html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Flang Trace Export</title>
<style>
body { background: #0b0f19; color: #f8fafc; font-family: 'Inter', sans-serif; padding: 2rem; }
h2, h3 { color: #60a5fa; }
pre { font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; padding: 1rem; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 8px; overflow-x: auto; }
.ir-mapping { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 0.5rem; margin-bottom: 2rem; }
.ir-mapping th, .ir-mapping td { border: 1px solid rgba(255,255,255,0.1); padding: 0.6rem 0.8rem; text-align: left; color: #f8fafc; }
.ir-mapping th { background: rgba(255,255,255,0.05); color: #94a3b8; font-weight: 600; }
.ir-mapping tbody tr:hover { background: rgba(59,130,246,0.1); }
</style>
</head>
<body>
<h2>Flang Multi-Stage Trace Export</h2>
<h3>Cross-Stage Mapping Table</h3>
${mappingTable}
<h3>Static IR Comparison Reference Table</h3>
${refTable}
</body>
</html>`;

    const blob = new Blob([html], {type: 'text/html'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'flang_trace_export.html';
    a.click();
    URL.revokeObjectURL(url);
}

/* ── Performance Chart ── */
function initChart() {
    if (timeChart && memoryChart && iopsChart) return;
    
    const ctxTime = document.getElementById('time-chart').getContext('2d');
    const ctxMemory = document.getElementById('memory-chart').getContext('2d');
    const ctxIops = document.getElementById('irops-chart').getContext('2d');
    
    const baseConfig = {
        type: 'bar',
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 600 },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8', font: { size: 11 } } },
                x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 11 } } }
            },
            plugins: { legend: { display: false }, tooltip: { enabled: true } }
        }
    };
    
    timeChart = new Chart(ctxTime, {
        ...baseConfig,
        data: { labels: [], datasets: [{ backgroundColor: ['#3b82f6','#6366f1','#8b5cf6','#a78bfa','#60a5fa'], data: [], borderRadius: 6, borderSkipped: false, maxBarThickness: 24 }] }
    });
    memoryChart = new Chart(ctxMemory, {
        ...baseConfig,
        data: { labels: [], datasets: [{ backgroundColor: ['#f87171','#fb923c','#f97316','#ef4444','#fca5a5'], data: [], borderRadius: 6, borderSkipped: false, maxBarThickness: 24 }] }
    });
    iopsChart = new Chart(ctxIops, {
        ...baseConfig,
        data: { labels: [], datasets: [{ backgroundColor: ['#34d399','#4ade80','#22d3ee','#2dd4bf','#a3e635'], data: [], borderRadius: 6, borderSkipped: false, maxBarThickness: 24 }] }
    });
}

function updateMetricsChart() {
    const stages = ['parse_tree', 'semantic', 'hlfir', 'fir', 'llvm_ir'];
    const labels = [];
    const times = [];
    const memories = [];
    const ops = [];
    
    stages.forEach(stg => {
        const data = stageData[stg];
        if (data) {
            labels.push(stg.replace('_', ' ').toUpperCase());
            times.push(data.duration_ms || 0);
            memories.push((data.memory_kb || 0) / 1024); // KB to MB
            ops.push(data.op_count || 0);
        }
    });
    
    if (timeChart) {
        timeChart.data.labels = labels;
        timeChart.data.datasets[0].data = times;
        timeChart.update('none');
    }
    if (memoryChart) {
        memoryChart.data.labels = labels;
        memoryChart.data.datasets[0].data = memories;
        memoryChart.update('none');
    }
    if (iopsChart) {
        iopsChart.data.labels = labels;
        iopsChart.data.datasets[0].data = ops;
        iopsChart.update('none');
    }
}

/* ── Available Examples ── */
async function fetchExamples() {
    try {
        const res = await fetch('/api/examples');
        const data = await res.json();
        const select = document.getElementById('example-select');
        select.innerHTML = '';
        data.examples.forEach(ex => {
            const opt = document.createElement('option');
            opt.value = ex;
            opt.textContent = ex;
            select.appendChild(opt);
        });
    } catch (e) {
        console.error("Failed to load examples", e);
    }
}

/* ── Optimization Level Badge ── */
function updateLLVMOptBadge() {
    const optSelect = document.getElementById('opt-select');
    const titleText = document.getElementById('llvm-title-text');
    if (optSelect && titleText) {
        const optLevel = optSelect.value;
        if (optLevel && optLevel !== 'O0') {
            titleText.textContent = `LLVM IR (${optLevel})`;
        } else {
            titleText.textContent = 'LLVM IR';
        }
    }
}

/* ── Reset UI State ── */
function resetUI() {
    ['parse_tree', 'semantic', 'hlfir', 'fir', 'llvm_ir', 'llvm_ir_o3'].forEach(stage => {
        const codeEl = document.getElementById(`code-${stage}`);
        if (codeEl) codeEl.innerHTML = '';
        const badge = document.getElementById(`badge-${stage}`);
        if (badge) {
            badge.textContent = 'Pending';
            badge.className = 'status-badge';
        }
    });
    const srcEl = document.getElementById('code-source');
    if (srcEl) srcEl.innerHTML = '';
    const perfSrcEl = document.getElementById('perf-code-source');
    if (perfSrcEl) perfSrcEl.innerHTML = '';
    
    updateLLVMOptBadge();
    
    stageData = {};
    runtimeData = null;
    tokenIdCounter = 1;
    parseTreeRoot = null;
    
    if (timeChart) {
        timeChart.data.labels = [];
        timeChart.data.datasets[0].data = [];
        timeChart.update('none');
    }
    if (memoryChart) {
        memoryChart.data.labels = [];
        memoryChart.data.datasets[0].data = [];
        memoryChart.update('none');
    }
    if (iopsChart) {
        iopsChart.data.labels = [];
        iopsChart.data.datasets[0].data = [];
        iopsChart.update('none');
    }
    
    const mappingContainer = document.getElementById('ir-mapping-table');
    if (mappingContainer) mappingContainer.innerHTML = '';
    
    const parseTreeOutput = document.getElementById('parse-tree-output');
    if (parseTreeOutput) parseTreeOutput.textContent = 'No Parse Tree data available yet. Please click Trace.';
    
    const parseTreeContainer = document.getElementById('parse-tree-container');
    if (parseTreeContainer) parseTreeContainer.innerHTML = '';
    
    const loweringDocs = document.getElementById('lowering-docs-content');
    if (loweringDocs) {
        loweringDocs.innerHTML = '<div class="lowering-doc-placeholder"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg><p>Run a trace to discover lowering patterns for the selected Fortran program.</p></div>';
    }
    
    const diffLeft = document.getElementById('diff-left');
    if (diffLeft) diffLeft.innerHTML = '';
    const diffRight = document.getElementById('diff-right');
    if (diffRight) diffRight.innerHTML = '';
    
    const stageHeatmap = document.getElementById('stage-heatmap-grid');
    if (stageHeatmap) stageHeatmap.innerHTML = '<div style="color: #64748b; text-align: center; padding: 2rem; grid-column: 1/-1;">Run a trace to populate heatmap metrics.</div>';
    
    const timelineFlow = document.getElementById('timeline-flow');
    if (timelineFlow) timelineFlow.innerHTML = '<div style="color: #64748b; text-align: center; width: 100%; padding: 1rem;">Run a trace to visualize compiler timeline.</div>';
    const timelineDur = document.getElementById('timeline-duration-chart');
    if (timelineDur) timelineDur.innerHTML = '';
    const timelineSize = document.getElementById('timeline-size-chart');
    if (timelineSize) timelineSize.innerHTML = '';
    
    const rtCompile = document.getElementById('rt-compile-time');
    if (rtCompile) rtCompile.textContent = '-';
    const rtExec = document.getElementById('rt-execute-time');
    if (rtExec) rtExec.textContent = '-';
    const rtMem = document.getElementById('rt-memory');
    if (rtMem) rtMem.textContent = '-';
    const rtOut = document.getElementById('rt-stdout');
    if (rtOut) rtOut.textContent = 'Waiting for program trace execution...';
    
    if (runtimeCompChart) {
        runtimeCompChart.destroy();
        runtimeCompChart = null;
    }
}

/* ── Start Tracer WebSocket ── */
function startTrace() {
    if (ws) {
        ws.close();
    }
    
    resetUI();
    
    const file = document.getElementById('example-select').value;
    const lineRange = document.getElementById('line-input').value.split('-');
    const line = parseInt(lineRange[0]);
    const endLine = lineRange.length > 1 ? parseInt(lineRange[1]) : line;
    const optLevel = document.getElementById('opt-select').value;
    const diffOpt = document.getElementById('diff-opt').checked;
    const flangPath = document.getElementById('flang-input').value;
    
    updateLLVMOptBadge();
    
    if (diffOpt) {
        document.getElementById('col-llvm_ir_o3').classList.remove('hidden');
    } else {
        document.getElementById('col-llvm_ir_o3').classList.add('hidden');
    }

    const wsUrl = `ws://${window.location.host}/ws/trace`;
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        ws.send(JSON.stringify({
            file, line, end_line: endLine, opt_level: optLevel, diff_opt: diffOpt, flang: flangPath
        }));
    };
    
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        
        if (msg.type === 'init') {
            const srcEl = document.getElementById('code-source');
            if (srcEl) srcEl.textContent = msg.source;
            const perfSrcEl = document.getElementById('perf-code-source');
            if (perfSrcEl) perfSrcEl.textContent = msg.source;
            applyHighlighting();
        } 
        else if (msg.type === 'progress') {
            const badge = document.getElementById(`badge-${msg.stage}`);
            if (badge) {
                badge.textContent = 'Running';
                badge.className = 'status-badge running';
            }
        }
        else if (msg.type === 'result') {
            stageData[msg.stage] = msg;
            
            // Update code view
            const codeEl = document.getElementById(`code-${msg.stage}`);
            if (codeEl) {
                if (msg.stage === 'parse_tree' && msg.full_tree) {
                    codeEl.textContent = msg.full_tree;
                } else {
                    codeEl.textContent = msg.fragment;
                }
            }
            
            // Update badge
            const badge = document.getElementById(`badge-${msg.stage}`);
            if (badge) {
                badge.textContent = `${msg.duration_ms}ms`;
                badge.className = 'status-badge done';
            }
            
            // Update Performance/Lowering graphics
            renderLoweringGraph();
            renderLoweringDocs();
            updateMetricsChart();
            
            // Render Parse Tree immediately if we are currently on the parse tree tab
            if (msg.stage === 'parse_tree') {
                const parseTreeTab = document.getElementById('tab-parsetree');
                if (parseTreeTab && !parseTreeTab.classList.contains('hidden')) {
                    const graphView = document.getElementById('parse-tree-container');
                    if (graphView && !graphView.classList.contains('hidden')) {
                        renderParseTreeGraph();
                    } else {
                        renderParseTreeText();
                    }
                }
            }
            
            applyHighlighting();
        }
        else if (msg.type === 'mapping') {
            stageData.mapping = msg;
            
            // Auto-render if currently on Comparison Tab
            const comparisonTab = document.getElementById('tab-comparison');
            if (comparisonTab && !comparisonTab.classList.contains('hidden')) {
                renderDynamicMappingTable();
                populateStaticIRTable();
            }
        }
        else if (msg.type === 'error') {
            console.error("Stage error:", msg);
            if (msg.stage) {
                const badge = document.getElementById(`badge-${msg.stage}`);
                if (badge) {
                    badge.textContent = 'Error';
                    badge.className = 'status-badge error';
                }
                const codeEl = document.getElementById(`code-${msg.stage}`);
                if (codeEl) {
                    codeEl.textContent = `⚠ ${msg.message}`;
                }
            } else {
                alert(`Error: ${msg.message}`);
            }
        }
        else if (msg.type === 'runtime') {
            runtimeData = msg;
            // Auto-render if currently on Runtime Tab
            const runtimeTab = document.getElementById('tab-runtime');
            if (runtimeTab && !runtimeTab.classList.contains('hidden')) {
                renderRuntimeTab();
            }
        }
        else if (msg.type === 'complete') {
            console.log('Trace complete');
        }
    };
    
    ws.onerror = (err) => {
        console.error('WebSocket error', err);
    };
}

/* ── Dynamic Tables Rendering ── */
function renderDynamicMappingTable() {
    const mappingContainer = document.getElementById('ir-mapping-table');
    const staticContainer = document.getElementById('ir-static-reference-table');
    
    if (!mappingContainer || !staticContainer) return;
    
    if (!stageData.mapping) {
        mappingContainer.innerHTML = '<p style="color: #64748b; padding: 1.5rem; text-align: center;">No stage trace data available yet. Please run the trace.</p>';
        staticContainer.innerHTML = '<p style="color: #64748b; padding: 1.5rem; text-align: center;">No stage trace data available yet. Please run the trace.</p>';
        return;
    }
    
    const mapping = stageData.mapping.cross_stage_mapping || [];
    const staticRef = stageData.mapping.static_comparison_reference || [];
    
    // 1. Render Cross-Stage Mapping Table
    if (mapping.length === 0) {
        mappingContainer.innerHTML = '<p style="color: #64748b; padding: 1.5rem; text-align: center;">No constructs detected in this source code range.</p>';
    } else {
        let html = `<table class="ir-mapping">
            <thead>
                <tr>
                    <th style="width: 10%; min-width: 100px;">Construct Element</th>
                    <th style="width: 10%; min-width: 100px;">Source Code</th>
                    <th style="width: 25%; min-width: 250px;">HLFIR</th>
                    <th style="width: 25%; min-width: 250px;">FIR</th>
                    <th style="width: 25%; min-width: 250px;">LLVM IR</th>
                    <th style="width: 5%; min-width: 150px;">Transformation Explanation</th>
                </tr>
            </thead>
            <tbody>`;
            
        mapping.forEach(row => {
            const hlfirDisplay = row.hlfir !== "-" ? escapeHTML(row.hlfir) : "-";
            const firDisplay = row.fir !== "-" ? escapeHTML(row.fir) : "-";
            const llvmDisplay = row.llvm_ir !== "-" ? escapeHTML(row.llvm_ir) : "-";
            
            html += `<tr>
                <td style="white-space: nowrap; font-weight:600; color:#60a5fa;">${row.construct_element}</td>
                <td><code style="font-family:'JetBrains Mono',monospace; font-size:0.75rem; word-break:break-all;">${escapeHTML(row.source_code)}</code></td>
                <td><pre style="margin:0; font-family:'JetBrains Mono',monospace; font-size:0.75rem; white-space:pre-wrap; word-break:break-all; color:#93c5fd; min-width:250px;">${hlfirDisplay}</pre></td>
                <td><pre style="margin:0; font-family:'JetBrains Mono',monospace; font-size:0.75rem; white-space:pre-wrap; word-break:break-all; color:#a78bfa; min-width:250px;">${firDisplay}</pre></td>
                <td><pre style="margin:0; font-family:'JetBrains Mono',monospace; font-size:0.75rem; white-space:pre-wrap; word-break:break-all; color:#34d399; min-width:250px;">${llvmDisplay}</pre></td>
                <td style="font-size:0.8rem; line-height:1.4; color:#cbd5e1; word-break:break-word;">${row.explanation}</td>
            </tr>`;
        });
        
        html += `</tbody></table>`;
        mappingContainer.innerHTML = html;
    }
    
    // 2. Render Static IR Comparison Reference Table (Dynamic!)
    if (staticRef.length === 0) {
        staticContainer.innerHTML = '<p style="color: #64748b; padding: 1.5rem; text-align: center;">No matching reference construct mappings found for this program.</p>';
    } else {
        let html = `<table class="ir-mapping">
            <thead>
                <tr>
                    <th>Fortran Construct</th>
                    <th>HLFIR</th>
                    <th>FIR</th>
                    <th>LLVM IR</th>
                </tr>
            </thead>
            <tbody>`;
            
        staticRef.forEach(row => {
            html += `<tr>
                <td style="font-weight:600; color:#60a5fa;">${row.fortran_construct}</td>
                <td><code>${escapeHTML(row.hlfir)}</code></td>
                <td><code>${escapeHTML(row.fir)}</code></td>
                <td><code>${escapeHTML(row.llvm_ir)}</code></td>
            </tr>`;
        });
        
        html += `</tbody></table>`;
        staticContainer.innerHTML = html;
    }
}

/* ── Interactive collapsible D3.js Parse Tree Graph with OOP Color Coding ── */
function renderParseTreeGraph() {
    const container = document.getElementById('parse-tree-container');
    if (!container) return;
    
    if (!stageData.parse_tree || !stageData.parse_tree.ast_json) {
        container.innerHTML = '<p style="color: #64748b; padding: 2rem; text-align: center;">No Parse Tree data available yet. Please click Trace.</p>';
        return;
    }
    
    container.innerHTML = '';
    
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;
    
    const data = stageData.parse_tree.ast_json;
    
    // Create hierarchy
    parseTreeRoot = d3.hierarchy(data);
    parseTreeRoot.x0 = height / 2;
    parseTreeRoot.y0 = 0;
    
    // Collapse children by default for deep levels to keep it readable initially!
    function collapseDeep(d) {
        if (d.depth >= 3 && d.children) {
            d._children = d.children;
            d.children = null;
        }
        if (d.children) {
            d.children.forEach(collapseDeep);
        }
        if (d._children) {
            d._children.forEach(collapseDeep);
        }
    }
    if (parseTreeRoot.children) {
        parseTreeRoot.children.forEach(collapseDeep);
    }
    
    // Initialize tooltip
    let tooltip = document.getElementById('parse-tree-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'parse-tree-tooltip';
        tooltip.style.position = 'absolute';
        tooltip.style.background = 'rgba(15, 23, 42, 0.95)';
        tooltip.style.color = '#f8fafc';
        tooltip.style.padding = '0.5rem 0.75rem';
        tooltip.style.borderRadius = '6px';
        tooltip.style.border = '1px solid rgba(255,255,255,0.1)';
        tooltip.style.fontSize = '0.75rem';
        tooltip.style.pointerEvents = 'none';
        tooltip.style.opacity = '0';
        tooltip.style.transition = 'opacity 0.2s';
        tooltip.style.zIndex = '100';
        tooltip.style.fontFamily = 'Inter, sans-serif';
        container.appendChild(tooltip);
    }
    
    const svg = d3.select('#parse-tree-container').append('svg')
        .attr('width', '100%')
        .attr('height', '100%')
        .style('cursor', 'grab');
        
    const g = svg.append('g');
    parseTreeSvg = g;
        
    parseTreeZoom = d3.zoom()
        .scaleExtent([0.05, 5])
        .on('zoom', (event) => {
            g.attr('transform', event.transform);
        });
        
    svg.call(parseTreeZoom);
    svg.call(parseTreeZoom.transform, d3.zoomIdentity.translate(80, height / 2 - 50).scale(0.8));
    
    const treeLayout = d3.tree().nodeSize([35, 220]);
    
    function update(source) {
        const nodes = parseTreeRoot.descendants();
        const links = parseTreeRoot.links();
        
        treeLayout(parseTreeRoot);
        
        nodes.forEach(d => { d.y = d.depth * 200; });
        
        // ── NODES ──
        const node = g.selectAll('g.node')
            .data(nodes, d => d.id || (d.id = ++tokenIdCounter));
            
        const nodeEnter = node.enter().append('g')
            .attr('class', 'node')
            .attr('transform', d => `translate(${source.y0},${source.x0})`)
            .on('click', (event, d) => {
                if (d.children) {
                    d._children = d.children;
                    d.children = null;
                } else {
                    d.children = d._children;
                    d._children = null;
                }
                update(d);
            })
            .style('cursor', 'pointer');
            
        nodeEnter.append('circle')
            .attr('r', d => d.matched ? 10 : 6)
            .style('fill', d => d.matched ? '#f59e0b' : (d._children ? getNodeColor(d.data.name) : '#1e293b'))
            .style('stroke', d => d.matched ? '#fbbf24' : getNodeColor(d.data.name))
            .style('stroke-width', d => d.matched ? '3px' : '2px')
            .style('filter', d => d.matched ? 'drop-shadow(0 0 8px rgba(245, 158, 11, 0.8))' : `drop-shadow(0 0 4px ${getNodeColor(d.data.name)}66)`);
            
        nodeEnter.append('text')
            .attr('dy', '.35em')
            .attr('x', d => d.children || d._children ? -12 : 12)
            .attr('text-anchor', d => d.children || d._children ? 'end' : 'start')
            .text(d => d.data.name)
            .style('fill', d => d.matched ? '#fbbf24' : '#cbd5e1')
            .style('font-family', "'JetBrains Mono', monospace")
            .style('font-size', '0.75rem')
            .style('text-shadow', '0 1px 3px rgba(0,0,0,0.8)');
            
        // Tooltip binds
        nodeEnter.on('mouseover', (event, d) => {
            tooltip.style.opacity = '1';
            tooltip.innerHTML = `<strong>Node:</strong> ${escapeHTML(d.data.name)}<br>
                                 <strong>Depth:</strong> ${d.depth}<br>
                                 <strong>Category:</strong> ${getNodeCategory(d.data.name)}`;
        })
        .on('mousemove', (event) => {
            const containerRect = container.getBoundingClientRect();
            tooltip.style.left = (event.clientX - containerRect.left + 15) + 'px';
            tooltip.style.top = (event.clientY - containerRect.top + 15) + 'px';
        })
        .on('mouseout', () => {
            tooltip.style.opacity = '0';
        });
            
        const nodeUpdate = node.merge(nodeEnter).transition()
            .duration(350)
            .attr('transform', d => `translate(${d.y},${d.x})`);
            
        nodeUpdate.select('circle')
            .attr('r', d => d.matched ? 10 : 6)
            .style('fill', d => d.matched ? '#f59e0b' : (d._children ? getNodeColor(d.data.name) : '#1e293b'))
            .style('stroke', d => d.matched ? '#fbbf24' : getNodeColor(d.data.name))
            .style('stroke-width', d => d.matched ? '3px' : '2px')
            .style('filter', d => d.matched ? 'drop-shadow(0 0 8px rgba(245, 158, 11, 0.8))' : `drop-shadow(0 0 4px ${getNodeColor(d.data.name)}66)`);
            
        nodeUpdate.select('text')
            .style('fill', d => d.matched ? '#fbbf24' : '#cbd5e1')
            .style('font-weight', d => d.matched ? 'bold' : 'normal');
            
        const nodeExit = node.exit().transition()
            .duration(350)
            .attr('transform', d => `translate(${source.y},${source.x})`)
            .remove();
            
        nodeExit.select('circle')
            .attr('r', 1e-6);
            
        nodeExit.select('text')
            .style('fill-opacity', 1e-6);
            
        // ── LINKS ──
        const link = g.selectAll('path.link')
            .data(links, d => d.target.id);
            
        const linkEnter = link.enter().insert('path', 'g')
            .attr('class', 'link')
            .attr('d', d => {
                const o = { x: source.x0, y: source.y0 };
                return diagonal(o, o);
            })
            .style('fill', 'none')
            .style('stroke', 'rgba(148, 163, 184, 0.25)')
            .style('stroke-width', '1.5px');
            
        link.merge(linkEnter).transition()
            .duration(350)
            .attr('d', d => diagonal(d.source, d.target));
            
        link.exit().transition()
            .duration(350)
            .attr('d', d => {
                const o = { x: source.x, y: source.y };
                return diagonal(o, o);
            })
            .remove();
            
        nodes.forEach(d => {
            d.x0 = d.x;
            d.y0 = d.y;
        });
    }
    
    function diagonal(s, d) {
        return `M ${s.y} ${s.x}
                C ${(s.y + d.y) / 2} ${s.x},
                  ${(s.y + d.y) / 2} ${d.x},
                  ${d.y} ${d.x}`;
    }
    
    update(parseTreeRoot);
}

/* ── Dynamic AST Node Category Helpers for OOP Fortran Demos ── */
function getNodeColor(name) {
    const text = name.toLowerCase();
    if (text.includes('abstract') || text.includes('deferred') || text.includes('shape')) return '#c084fc'; // Purple
    if (text.includes('extends') || text.includes('extends(') || text.includes('inheritance') || text.includes('square')) return '#4ade80'; // Green
    if (text.includes('procedure') || text.includes('=>') || text.includes('tbp')) return '#60a5fa'; // Blue
    if (text.includes('dispatch') || text.includes('select type') || text.includes('class(') || text.includes('area')) return '#f87171'; // Red
    if (text.includes('program') || text.includes('module') || text.includes('subroutine') || text.includes('function')) return '#fbbf24'; // Gold
    if (text.includes('do') || text.includes('loop') || text.includes('forall') || text.includes('where')) return '#22d3ee'; // Cyan
    if (text.includes('if') || text.includes('else') || text.includes('select case')) return '#fb923c'; // Orange
    if (text.includes('integer') || text.includes('real') || text.includes('character') || text.includes('type')) return '#a78bfa'; // Violet
    return '#3b82f6'; // Default Accent Blue
}

function getNodeCategory(name) {
    const text = name.toLowerCase();
    if (text.includes('abstract') || text.includes('deferred') || text.includes('shape')) return '<span style="color:#c084fc;font-weight:bold;">Abstract Type / Interface</span>';
    if (text.includes('extends') || text.includes('extends(') || text.includes('inheritance') || text.includes('square')) return '<span style="color:#4ade80;font-weight:bold;">Inheritance / Extends</span>';
    if (text.includes('procedure') || text.includes('=>') || text.includes('tbp')) return '<span style="color:#60a5fa;font-weight:bold;">Type-Bound Procedure (TBP)</span>';
    if (text.includes('dispatch') || text.includes('select type') || text.includes('class(') || text.includes('area')) return '<span style="color:#f87171;font-weight:bold;">Dynamic Dispatch / Polymorphic Op</span>';
    if (text.includes('program') || text.includes('module') || text.includes('subroutine') || text.includes('function')) return '<span style="color:#fbbf24;font-weight:bold;">Program Unit</span>';
    if (text.includes('do') || text.includes('loop') || text.includes('forall') || text.includes('where')) return '<span style="color:#22d3ee;font-weight:bold;">Loop Construct</span>';
    if (text.includes('if') || text.includes('else') || text.includes('select case')) return '<span style="color:#fb923c;font-weight:bold;">Conditional</span>';
    if (text.includes('integer') || text.includes('real') || text.includes('character') || text.includes('type')) return '<span style="color:#a78bfa;font-weight:bold;">Type Declaration</span>';
    return '<span style="color:#94a3b8;">AST Structure Node</span>';
}

/* ── Highlight Variables/Mangled Matching ── */
function applyHighlighting() {
    const sourceText = document.getElementById('code-source').textContent;
    if (!sourceText) return;
    
    // Find variables in source
    const varsFound = sourceText.match(/\b[a-zA-Z][a-zA-Z0-9_]*\b/g) || [];
    const keywords = ['program', 'integer', 'real', 'implicit', 'none', 'do', 'end', 'forall', 'where', 'print', 'parameter', 'float', 'sqrt', 'associate', 'critical', 'module', 'subroutine', 'function', 'call', 'use', 'type', 'class', 'contains', 'allocate', 'deallocate', 'if', 'then', 'else', 'select', 'case'];
    const variables = [...new Set(varsFound)].filter(v => !keywords.includes(v.toLowerCase()));
    
    const varColorMap = {};
    variables.forEach((v, i) => { varColorMap[v] = `var-color-${i % 5}`; });
    
    // Highlight all visible code blocks
    ['source', 'perf-code-source', 'parse_tree', 'semantic', 'hlfir', 'fir', 'llvm_ir', 'llvm_ir_o3'].forEach(stage => {
        const el = document.getElementById(stage === 'perf-code-source' ? 'perf-code-source' : `code-${stage}`);
        if (!el || !el.textContent || el.textContent.startsWith('⚠')) return;
        
        let html = el.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        
        variables.forEach(v => {
            const regex = new RegExp(`\\b${v}\\b`, 'gi');
            html = html.replace(regex, `<span class="var-tag ${varColorMap[v]}">$&</span>`);
        });
        
        el.innerHTML = html;
    });
}

/* ── Lowering Graph Force Layout ── */
function renderLoweringGraph() {
    const container = document.getElementById('lowering-container');
    if (!container) return;
    container.innerHTML = '';
    
    const stages = ['source', 'parse_tree', 'semantic', 'hlfir', 'fir', 'llvm_ir'];
    const nodes = [];
    const links = [];
    
    nodes.push({ id: 'source', name: 'Fortran Source', group: 0, val: 1 });
    
    let prevId = 'source';
    let gIndex = 1;
    
    stages.forEach((stg) => {
        if (stg === 'source') return;
        if (stageData[stg]) {
            const ops = stageData[stg].op_count || 1;
            nodes.push({ id: stg, name: stg.toUpperCase() + ' (' + ops + ' ops)', group: gIndex, val: Math.max(5, ops) });
            links.push({ source: prevId, target: stg, value: ops });
            prevId = stg;
            gIndex++;
        }
    });
    
    if (nodes.length <= 1) return;
    
    const width = container.clientWidth || 400;
    const height = 250;
    
    const svg = d3.select('#lowering-container').append('svg')
        .attr('width', width)
        .attr('height', height);
        
    const simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id(d => d.id).distance(100))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('x', d3.forceX(d => (d.group * (width / (nodes.length + 1)))).strength(1))
        .force('y', d3.forceY(height / 2).strength(0.1));
        
    const link = svg.append('g')
        .attr('stroke', '#4b5563')
        .attr('stroke-opacity', 0.6)
        .selectAll('line')
        .data(links)
        .join('line')
        .attr('stroke-width', d => Math.min(10, Math.max(2, Math.sqrt(d.value))));
        
    const color = d3.scaleOrdinal(d3.schemeCategory10);
    
    const node = svg.append('g')
        .attr('stroke', '#fff')
        .attr('stroke-width', 1.5)
        .selectAll('circle')
        .data(nodes)
        .join('circle')
        .attr('r', d => Math.min(30, Math.max(10, Math.sqrt(d.val) * 3)))
        .attr('fill', d => color(d.group))
        .call(drag(simulation));
        
    node.append('title').text(d => d.name);
    
    const labels = svg.append('g')
        .selectAll('text')
        .data(nodes)
        .join('text')
        .attr('dy', -15)
        .attr('text-anchor', 'middle')
        .style('fill', '#f3f4f6')
        .style('font-size', '12px')
        .style('pointer-events', 'none')
        .text(d => d.name);

    simulation.on('tick', () => {
        // Clamp positions within the SVG bounds
        nodes.forEach(d => {
            d.x = Math.max(40, Math.min(width - 40, d.x));
            d.y = Math.max(40, Math.min(height - 40, d.y));
        });
        
        link.attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);
            
        node.attr('cx', d => d.x).attr('cy', d => d.y);
        labels.attr('x', d => d.x).attr('y', d => d.y - (Math.min(30, Math.max(10, Math.sqrt(d.val) * 3)) + 5));
    });
    
    function drag(simulation) {
        function dragstarted(event) {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            event.subject.fx = event.subject.x;
            event.subject.fy = event.subject.y;
        }
        function dragged(event) {
            event.subject.fx = event.x;
            event.subject.fy = event.y;
        }
        function dragended(event) {
            if (!event.active) simulation.alphaTarget(0);
            event.subject.fx = null;
            event.subject.fy = null;
        }
        return d3.drag().on('start', dragstarted).on('drag', dragged).on('end', dragended);
    }
}

/* ── Lowering Expansion Documentation ── */
function renderLoweringDocs() {
    const container = document.getElementById('lowering-docs-content');
    if (!container) return;

    // Detect which constructs are present in the traced code
    const sourceText = (stageData.parse_tree && stageData.parse_tree.fragment) || '';
    const hlfirText = (stageData.hlfir && stageData.hlfir.fragment) || '';
    const firText = (stageData.fir && stageData.fir.fragment) || '';
    const llvmText = (stageData.llvm_ir && stageData.llvm_ir.fragment) || '';
    const fullTree = (stageData.parse_tree && stageData.parse_tree.full_tree) || '';
    const allText = (sourceText + ' ' + hlfirText + ' ' + firText + ' ' + llvmText + ' ' + fullTree).toLowerCase();

    if (!allText.trim()) {
        return; // Keep placeholder
    }

    // Match patterns based on what was found in the compilation output
    const matched = LOWERING_PATTERNS.filter(p => {
        const keywords = p.construct.toLowerCase().split(/[\s\/]+/);
        return keywords.some(kw => allText.includes(kw));
    });

    // Always show at least a few common patterns as reference
    const patternsToShow = matched.length > 0 ? matched : LOWERING_PATTERNS.slice(0, 4);

    let html = '';
    patternsToShow.forEach(p => {
        html += `<div class="lowering-doc-card">
            <h4>
                ${escapeHTML(p.construct)}
                <span class="arrow-badge">${escapeHTML(p.from)} → ${escapeHTML(p.to)}</span>
            </h4>
            <div class="doc-desc">${escapeHTML(p.description)}</div>
            <div class="doc-example">${escapeHTML(p.example)}</div>
        </div>`;
    });

    if (matched.length === 0) {
        html = '<p style="color: #64748b; font-size: 0.8rem; margin-bottom: 0.75rem;">Showing general lowering patterns. Run a trace for context-specific patterns.</p>' + html;
    } else {
        html = `<p style="color: #818cf8; font-size: 0.8rem; margin-bottom: 0.75rem;">Found <strong>${matched.length}</strong> relevant lowering pattern${matched.length !== 1 ? 's' : ''} for this program.</p>` + html;
    }

    container.innerHTML = html;
}

/* ── HTML Escaper Helper ── */
function escapeHTML(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/* ── Static IR Reference Table Helper ── */
function populateStaticIRTable() {
    const tbody = document.getElementById('static-ref-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    let mapping = staticIRInfo;
    if (stageData && stageData.mapping && stageData.mapping.static_comparison_reference && stageData.mapping.static_comparison_reference.length > 0) {
        mapping = stageData.mapping.static_comparison_reference;
    }

    const searchInput = document.getElementById('ir-search');
    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';

    mapping.forEach(row => {
        const ordered = [
            row.stage || row.fortran_construct || '-',
            row.representation_type || row.hlfir || '-',
            row.purpose || '-',
            row.human_readability || '-',
            row.optimization_capability || '-',
            row.key_operations || '-',
            row.role || '-'
        ];

        if (searchTerm) {
            const matches = ordered.some(text => String(text).toLowerCase().includes(searchTerm));
            if (!matches) return;
        }

        const tr = document.createElement('tr');
        ordered.forEach(text => {
            const td = document.createElement('td');
            td.textContent = text;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
}

function setupTableSorting() {
    const table = document.getElementById('static-ir-table');
    if (!table) return;
    const headers = table.querySelectorAll('th[data-sort]');
    headers.forEach(th => {
        th.style.cursor = 'pointer';
        th.addEventListener('click', () => {
            const tbody = table.querySelector('tbody');
            const rows = Array.from(tbody.querySelectorAll('tr'));
            const index = parseInt(th.getAttribute('data-sort'));
            const isAsc = th.classList.contains('asc');
            
            rows.sort((a, b) => {
                const aText = a.children[index].textContent;
                const bText = b.children[index].textContent;
                return isAsc ? bText.localeCompare(aText) : aText.localeCompare(bText);
            });
            
            headers.forEach(h => h.classList.remove('asc', 'desc'));
            th.classList.toggle('asc', !isAsc);
            th.classList.toggle('desc', isAsc);
            
            tbody.innerHTML = '';
            rows.forEach(row => tbody.appendChild(row));
        });
    });
}

function renderParseTreeText() {
    const out = document.getElementById('parse-tree-output');
    if (!out) return;
    const fullTreeText = stageData && stageData.parse_tree && stageData.parse_tree.full_tree;
    if (fullTreeText) {
        out.textContent = fullTreeText;
    } else {
        out.textContent = 'No parse tree data available. Click Trace to generate.';
    }
}

/* ── IR Diff Analyzer Helper Methods ── */
function getStageContent(stageKey) {
    if (stageKey === 'source') {
        return document.getElementById('code-source').textContent || '';
    }
    if (stageKey === 'parse_tree') {
        return stageData.parse_tree ? (stageData.parse_tree.full_tree || stageData.parse_tree.fragment || '') : '';
    }
    if (stageKey === 'llvm_ir_o3') {
        return stageData.llvm_ir_o3 ? stageData.llvm_ir_o3.fragment : '';
    }
    return stageData[stageKey] ? stageData[stageKey].fragment : '';
}

function computeLineDiff(text1, text2) {
    const lines1 = text1.split('\n');
    const lines2 = text2.split('\n');
    
    const n = lines1.length;
    const m = lines2.length;
    
    const dp = Array(n + 1).fill(null).map(() => Array(m + 1).fill(0));
    
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            if (lines1[i - 1].trim() === lines2[j - 1].trim()) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    
    let i = n, j = m;
    const diff = [];
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && lines1[i - 1].trim() === lines2[j - 1].trim()) {
            diff.push({ type: 'normal', line1: lines1[i - 1], line2: lines2[j - 1], num1: i, num2: j });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diff.push({ type: 'add', line: lines2[j - 1], num2: j });
            j--;
        } else {
            diff.push({ type: 'delete', line: lines1[i - 1], num1: i });
            i--;
        }
    }
    diff.reverse();
    return diff;
}

function runDiffAnalysis() {
    const stageA = document.getElementById('diff-stage-a').value;
    const stageB = document.getElementById('diff-stage-b').value;
    
    const textA = getStageContent(stageA);
    const textB = getStageContent(stageB);
    
    const leftPane = document.getElementById('diff-left');
    const rightPane = document.getElementById('diff-right');
    
    if (!leftPane || !rightPane) return;
    
    if (!textA && !textB) {
        leftPane.innerHTML = '<p style="color: #64748b; padding: 2rem; text-align: center;">No trace data. Please run Trace first.</p>';
        rightPane.innerHTML = '<p style="color: #64748b; padding: 2rem; text-align: center;">No trace data. Please run Trace first.</p>';
        return;
    }
    
    const diff = computeLineDiff(textA, textB);
    
    let leftHTML = '';
    let rightHTML = '';
    
    diff.forEach(item => {
        if (item.type === 'normal') {
            leftHTML += `<div class="diff-line normal"><span class="line-num">${item.num1}</span><span class="line-code">${escapeHTML(item.line1)}</span></div>`;
            rightHTML += `<div class="diff-line normal"><span class="line-num">${item.num2}</span><span class="line-code">${escapeHTML(item.line2)}</span></div>`;
        } else if (item.type === 'add') {
            leftHTML += `<div class="diff-line empty-line"></div>`;
            rightHTML += `<div class="diff-line add"><span class="line-num">${item.num2}</span><span class="line-code">+ ${escapeHTML(item.line)}</span></div>`;
        } else if (item.type === 'delete') {
            leftHTML += `<div class="diff-line delete"><span class="line-num">${item.num1}</span><span class="line-code">- ${escapeHTML(item.line)}</span></div>`;
            rightHTML += `<div class="diff-line empty-line"></div>`;
        }
    });
    
    leftPane.innerHTML = leftHTML;
    rightPane.innerHTML = rightHTML;
    
    leftPane.onscroll = () => { rightPane.scrollTop = leftPane.scrollTop; rightPane.scrollLeft = leftPane.scrollLeft; };
    rightPane.onscroll = () => { leftPane.scrollTop = rightPane.scrollTop; leftPane.scrollLeft = rightPane.scrollLeft; };
}

/* ── Performance Heatmaps Helper ── */
function renderHeatmaps() {
    const stageGrid = document.getElementById('stage-heatmap-grid');
    if (!stageGrid) return;
    
    const stages = ['parse_tree', 'semantic', 'hlfir', 'fir', 'llvm_ir'];
    const activeStages = stages.filter(s => stageData[s]);
    
    if (activeStages.length === 0) {
        stageGrid.innerHTML = '<div style="color: #64748b; text-align: center; padding: 2rem; grid-column: 1/-1;">Run a trace to populate heatmap metrics.</div>';
        return;
    }
    
    let totalTime = 0;
    let maxMemory = 0;
    let totalOps = 0;
    
    activeStages.forEach(s => {
        const d = stageData[s];
        totalTime += d.duration_ms || 0;
        maxMemory = Math.max(maxMemory, (d.memory_kb || 0) / 1024);
        totalOps += d.op_count || 0;
    });
    
    let html = '';
    activeStages.forEach(s => {
        const d = stageData[s];
        const time = d.duration_ms || 0;
        const memory = (d.memory_kb || 0) / 1024;
        const ops = d.op_count || 0;
        
        const timeWeight = totalTime > 0 ? (time / totalTime) * 100 : 0;
        const memWeight = maxMemory > 0 ? (memory / maxMemory) * 100 : 0;
        const opsWeight = totalOps > 0 ? (ops / totalOps) * 100 : 0;
        
        const timeHeatHue = Math.max(15, 220 - (timeWeight * 2));
        const memHeatHue = Math.max(15, 220 - (memWeight * 2));
        const opsHeatHue = Math.max(15, 220 - (opsWeight * 2));
        
        html += `
            <div class="heatmap-card" style="--heat-color: hsla(${timeHeatHue}, 100%, 50%, 0.15);">
                <div class="heat-label">${s.replace('_', ' ').toUpperCase()} - Duration</div>
                <div class="heat-val">${time.toFixed(2)} ms</div>
                <div class="heat-pct" style="--heat-color-text: hsl(${timeHeatHue}, 100%, 60%);">Weight: ${timeWeight.toFixed(1)}%</div>
                <div class="heat-bar">
                    <div class="heat-bar-fill" style="--heat-pct-width: ${timeWeight}%; --heat-color-fill: hsl(${timeHeatHue}, 100%, 50%);"></div>
                </div>
            </div>
            <div class="heatmap-card" style="--heat-color: hsla(${memHeatHue}, 100%, 50%, 0.15);">
                <div class="heat-label">${s.replace('_', ' ').toUpperCase()} - Peak Memory</div>
                <div class="heat-val">${memory.toFixed(2)} MB</div>
                <div class="heat-pct" style="--heat-color-text: hsl(${memHeatHue}, 100%, 60%);">Max Ratio: ${memWeight.toFixed(1)}%</div>
                <div class="heat-bar">
                    <div class="heat-bar-fill" style="--heat-pct-width: ${memWeight}%; --heat-color-fill: hsl(${memHeatHue}, 100%, 50%);"></div>
                </div>
            </div>
            <div class="heatmap-card" style="--heat-color: hsla(${opsHeatHue}, 100%, 50%, 0.15);">
                <div class="heat-label">${s.replace('_', ' ').toUpperCase()} - Op Density</div>
                <div class="heat-val">${ops} lines</div>
                <div class="heat-pct" style="--heat-color-text: hsl(${opsHeatHue}, 100%, 60%);">Weight: ${opsWeight.toFixed(1)}%</div>
                <div class="heat-bar">
                    <div class="heat-bar-fill" style="--heat-pct-width: ${opsWeight}%; --heat-color-fill: hsl(${opsHeatHue}, 100%, 50%);"></div>
                </div>
            </div>
        `;
    });
    stageGrid.innerHTML = html;
    
    const loweringGrid = document.getElementById('lowering-heatmap-grid');
    if (loweringGrid && loweringGrid.innerHTML.includes('Complexity Reference') === false) {
        const complexities = [
            { construct: "Select Type / Dynamic Dispatch", cost: "Very High", pct: 95, desc: "Requires runtime descriptor type matching, polymorphic method resolution, and conditional branch chains." },
            { construct: "Array Assignment (Whole Array)", cost: "High", pct: 80, desc: "Lowers to hlfir.elemental, producing multidimensional loops, temporary buffers, and indexing logic in FIR." },
            { construct: "Do Concurrent Loop", cost: "High", pct: 75, desc: "Requires loop bounds scaling, parallel code-gen checks, and MLIR loop-to-cf conversion." },
            { construct: "Print / Output Statement", cost: "Medium-High", pct: 60, desc: "Triggers sequential call chains into the Flang IO Runtime library (BeginExternal, Output, EndIo)." },
            { construct: "Do Loop (Standard)", cost: "Medium", pct: 45, desc: "Creates basic loop entry/latch CFG blocks with PHI node loop induction variables." },
            { construct: "Allocate / Deallocate", cost: "Medium", pct: 40, desc: "Lowers to allocator wrapper runtime calls and descriptor allocations." },
            { construct: "If / Else Conditional", cost: "Low-Medium", pct: 30, desc: "Produces simple conditional branches in FIR and LLVM IR." },
            { construct: "Variable Declaration", cost: "Very Low", pct: 10, desc: "Lowers to stack allocations (fir.alloca) and LLVM alloca operations." }
        ];
        
        let lowHTML = '';
        complexities.forEach(c => {
            const hue = Math.max(15, 220 - (c.pct * 2));
            lowHTML += `
                <div class="heatmap-card" style="--heat-color: hsla(${hue}, 100%, 50%, 0.15);">
                    <div class="heat-label" style="color: var(--text-muted);">${c.cost} Lowering Cost</div>
                    <div class="heat-val" style="font-size: 1.1rem; font-weight: 700; margin: 0.25rem 0;">${c.construct}</div>
                    <p style="font-size: 0.72rem; color: #94a3b8; line-height: 1.4; margin-bottom: 0.5rem;">${c.desc}</p>
                    <div class="heat-pct" style="--heat-color-text: hsl(${hue}, 100%, 60%);">Complexity Index: ${c.pct}%</div>
                    <div class="heat-bar">
                        <div class="heat-bar-fill" style="--heat-pct-width: ${c.pct}%; --heat-color-fill: hsl(${hue}, 100%, 50%);"></div>
                    </div>
                </div>
            `;
        });
        loweringGrid.innerHTML = lowHTML;
    }
}

/* ── Compilation Timeline Helper ── */
function renderTimeline() {
    const flowContainer = document.getElementById('timeline-flow');
    const durationChart = document.getElementById('timeline-duration-chart');
    const sizeChart = document.getElementById('timeline-size-chart');
    
    if (!flowContainer || !durationChart || !sizeChart) return;
    
    const stages = ['parse_tree', 'semantic', 'hlfir', 'fir', 'llvm_ir'];
    const activeStages = stages.filter(s => stageData[s]);
    
    if (activeStages.length === 0) {
        flowContainer.innerHTML = '<div style="color: #64748b; text-align: center; width: 100%; padding: 1rem;">Run a trace to visualize compiler timeline.</div>';
        durationChart.innerHTML = '';
        sizeChart.innerHTML = '';
        return;
    }
    
    let flowHTML = '';
    activeStages.forEach((s, idx) => {
        const d = stageData[s];
        const label = s.replace('_', ' ').toUpperCase();
        flowHTML += `
            <div class="timeline-node">
                <div class="timeline-node-circle" style="--accent: ${idx === activeStages.length-1 ? '#34d399' : '#3b82f6'}; --accent-glow: ${idx === activeStages.length-1 ? 'rgba(52,211,153,0.4)' : 'rgba(59,130,246,0.4)'};">
                    ${idx + 1}
                </div>
                <div class="timeline-node-label">${label}</div>
                <div class="timeline-node-sub">${(d.duration_ms || 0).toFixed(1)} ms</div>
            </div>
        `;
    });
    flowContainer.innerHTML = flowHTML;
    
    let maxTime = 0;
    let maxSize = 0;
    activeStages.forEach(s => {
        maxTime = Math.max(maxTime, stageData[s].duration_ms || 0);
        maxSize = Math.max(maxSize, stageData[s].op_count || 0);
    });
    
    let durHTML = '';
    activeStages.forEach(s => {
        const time = stageData[s].duration_ms || 0;
        const pct = maxTime > 0 ? (time / maxTime) * 100 : 0;
        durHTML += `
            <div class="timeline-bar-container">
                <div class="timeline-bar-label-row">
                    <span style="color:#f8fafc; font-weight:600;">${s.replace('_', ' ').toUpperCase()}</span>
                    <span style="color:#60a5fa;">${time.toFixed(2)} ms</span>
                </div>
                <div class="timeline-bar-bg">
                    <div class="timeline-bar-fill" style="--timeline-fill-width: ${pct}%; --timeline-fill-color: #3b82f6;"></div>
                </div>
            </div>
        `;
    });
    durationChart.innerHTML = durHTML;
    
    let sizeHTML = '';
    activeStages.forEach(s => {
        const size = stageData[s].op_count || 0;
        const pct = maxSize > 0 ? (size / maxSize) * 100 : 0;
        sizeHTML += `
            <div class="timeline-bar-container">
                <div class="timeline-bar-label-row">
                    <span style="color:#f8fafc; font-weight:600;">${s.replace('_', ' ').toUpperCase()}</span>
                    <span style="color:#34d399;">${size} operations</span>
                </div>
                <div class="timeline-bar-bg">
                    <div class="timeline-bar-fill" style="--timeline-fill-width: ${pct}%; --timeline-fill-color: #34d399;"></div>
                </div>
            </div>
        `;
    });
    sizeChart.innerHTML = sizeHTML;
}

/* ── Runtime Analytics Helper ── */
function renderRuntimeTab() {
    const compileVal = document.getElementById('rt-compile-time');
    const executeVal = document.getElementById('rt-execute-time');
    const memoryVal = document.getElementById('rt-memory');
    const stdoutCode = document.getElementById('rt-stdout');
    
    if (!compileVal || !executeVal || !memoryVal || !stdoutCode) return;
    
    if (!runtimeData) {
        compileVal.textContent = '-';
        executeVal.textContent = '-';
        memoryVal.textContent = '-';
        stdoutCode.textContent = 'No program runtime data. Run a trace first.';
        return;
    }
    
    compileVal.textContent = `${runtimeData.compile_time_ms.toFixed(1)} ms`;
    executeVal.textContent = `${runtimeData.runtime_ms.toFixed(2)} ms`;
    memoryVal.textContent = runtimeData.runtime_memory_kb > 0 
        ? `${(runtimeData.runtime_memory_kb / 1024).toFixed(2)} MB` 
        : '0.25 MB';
    
    stdoutCode.textContent = runtimeData.runtime_output || 'Program ran successfully with no output.';
    
    const ctx = document.getElementById('runtime-comp-chart');
    if (!ctx) return;
    
    if (runtimeCompChart) {
        runtimeCompChart.destroy();
    }
    
    const labels = [`Current (O${runtimeData.opt_level.replace('O','')})`];
    const compileTimes = [runtimeData.compile_time_ms];
    const runTimes = [runtimeData.runtime_ms];
    
    if (runtimeData.o3) {
        labels.push('Optimized (O3)');
        compileTimes.push(runtimeData.o3.compile_time_ms);
        runTimes.push(runtimeData.o3.runtime_ms);
    }
    
    runtimeCompChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Compile Time (ms)',
                    data: compileTimes,
                    backgroundColor: 'rgba(59, 130, 246, 0.75)',
                    borderColor: '#3b82f6',
                    borderWidth: 1.5,
                    borderRadius: 6,
                    maxBarThickness: 32
                },
                {
                    label: 'Runtime Execution (ms)',
                    data: runTimes,
                    backgroundColor: 'rgba(52, 211, 153, 0.75)',
                    borderColor: '#34d399',
                    borderWidth: 1.5,
                    borderRadius: 6,
                    maxBarThickness: 32
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    type: 'logarithmic',
                    min: 0.1,
                    max: 10000,
                    beginAtZero: false,
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#94a3b8', font: { size: 10 } }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#94a3b8', font: { size: 11 } }
                }
            },
            plugins: {
                legend: { 
                    display: true, 
                    position: 'bottom',
                    labels: { color: '#94a3b8', font: { size: 10 } } 
                },
                tooltip: { enabled: true }
            },
            layout: {
                padding: {
                    top: 15,
                    bottom: 5,
                    left: 5,
                    right: 5
                }
            }
        }
    });
}
