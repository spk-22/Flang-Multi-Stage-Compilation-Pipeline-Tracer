import subprocess
import os
import time
import sys
from typing import Dict, List, Optional, Tuple

def to_wsl_path(path: str) -> str:
    # Resolve absolute path
    path = os.path.abspath(path)
    # Check for drive letter e.g. D:\
    if len(path) > 1 and path[1] == ':':
        drive = path[0].lower()
        remainder = path[2:].replace('\\', '/')
        return f"/mnt/{drive}{remainder}"
    return path.replace('\\', '/')

class FlangDriver:
    def __init__(self, flang_path: str = "flang-new", opt_level: str = "O0"):
        self.flang_path = flang_path
        self.opt_level = opt_level if opt_level.startswith("O") else f"O{opt_level}"

    def run_stage(self, input_file: str, stage_flags: List[str]) -> Tuple[str, float]:
        use_wsl = False
        flang_exe = self.flang_path
        input_path = input_file

        if sys.platform == 'win32':
            use_wsl = True

        flags_to_use = list(stage_flags)
        if "coarray" in input_file.lower():
            if "-fcoarray" not in flags_to_use:
                flags_to_use.append("-fcoarray")

        if use_wsl:
            input_path = to_wsl_path(input_file)
            if len(flang_exe) > 1 and flang_exe[1] == ':':
                flang_exe = to_wsl_path(flang_exe)
            cmd = ["wsl", flang_exe] + flags_to_use + [input_path]
        else:
            cmd = [flang_exe] + flags_to_use + [input_path]

        start_time = time.perf_counter()
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True
            )
            elapsed = time.perf_counter() - start_time
            # Memory usage of child processes (in KB). Works on Linux/WSL.
            try:
                import resource
                mem_kb = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
            except Exception:
                mem_kb = 0
            return result.stdout, elapsed, mem_kb
        except subprocess.CalledProcessError as e:
            elapsed = time.perf_counter() - start_time
            print(f"Error running stage with command {' '.join(cmd)}: {e.stderr}")
            return "", elapsed, 0

    def get_parse_tree(self, input_file: str) -> str:
        content, _, _ = self.run_stage(input_file, ["-fc1", "-fdebug-dump-parse-tree"])
        return content

    def get_symbols(self, input_file: str) -> str:
        content, _, _ = self.run_stage(input_file, ["-fc1", "-fget-symbols-sources"])
        return content

    def get_fir(self, input_file: str) -> str:
        # Use Flang's FIR dump flag to produce MLIR representation
        content, _, _ = self.run_stage(input_file, ["-fc1", "-fdump-fir", "-mmlir", "--mlir-print-debuginfo", "-o", "-"])
        return content

    def get_hlfir(self, input_file: str) -> str:
        # Use Flang's HLFIR dump flag to produce MLIR representation
        content, _, _ = self.run_stage(input_file, ["-fc1", "-fdump-hlfir", "-mmlir", "--mlir-print-debuginfo", "-o", "-"])
        return content

    def get_llvm_ir(self, input_file: str) -> str:
        content, _, _ = self.run_stage(input_file, ["-S", "-emit-llvm", "-g", f"-{self.opt_level}", "-o", "-"])
        return content

    def get_all_dumps(self, input_file: str) -> Dict[str, Dict[str, any]]:
        stages = {
            "parse_tree": ["-fc1", "-fdebug-dump-parse-tree"],
            "symbols": ["-fc1", "-fget-symbols-sources"],
            "fir": ["-fc1", "-emit-fir", "-mmlir", "--mlir-print-debuginfo", "-o", "-"],
            "hlfir": ["-fc1", "-emit-hlfir", "-mmlir", "--mlir-print-debuginfo", "-o", "-"],
            "llvm_ir": ["-S", "-emit-llvm", "-g", f"-{self.opt_level}", "-o", "-"]
        }
        
        results = {}
        for name, flags in stages.items():
            content, duration, _ = self.run_stage(input_file, flags)
            results[name] = {
                "content": content,
                "duration_ms": round(duration * 1000, 2)
            }
        return results

    def run_binary(self, input_file: str) -> Tuple[float, float, float, str]:
        """Compile the file and run it, measuring compile time, run time, run memory, and stdout."""
        use_wsl = sys.platform == 'win32'
        flang_exe = self.flang_path
        input_path = to_wsl_path(input_file) if use_wsl else input_file
        
        import uuid
        temp_bin_name = f"temp_bin_{uuid.uuid4().hex}"
        temp_bin_path = f"/tmp/{temp_bin_name}" if use_wsl else os.path.join(os.path.dirname(input_file), temp_bin_name)
        
        flags = [f"-{self.opt_level}"]
        if "coarray" in input_file.lower():
            flags.append("-fcoarray")
            
        if use_wsl:
            if len(flang_exe) > 1 and flang_exe[1] == ':':
                flang_exe = to_wsl_path(flang_exe)
            compile_cmd = ["wsl", flang_exe] + flags + [input_path, "-o", temp_bin_path]
            run_cmd = ["wsl", temp_bin_path]
        else:
            compile_cmd = [flang_exe] + flags + [input_path, "-o", temp_bin_path]
            run_cmd = [temp_bin_path]
            
        try:
            # 1. Compile
            start_compile = time.perf_counter()
            subprocess.run(compile_cmd, check=True, capture_output=True)
            compile_time = time.perf_counter() - start_compile
            
            # 2. Run
            start_run = time.perf_counter()
            run_res = subprocess.run(run_cmd, check=True, capture_output=True, text=True)
            run_time = time.perf_counter() - start_run
            
            try:
                import resource
                run_mem_kb = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
            except Exception:
                run_mem_kb = 0
                
            # Cleanup
            if use_wsl:
                subprocess.run(["wsl", "rm", "-f", temp_bin_path])
            else:
                if os.path.exists(temp_bin_path):
                    os.remove(temp_bin_path)
                    
            return compile_time, run_time, run_mem_kb, run_res.stdout
            
        except Exception as e:
            try:
                if use_wsl:
                    subprocess.run(["wsl", "rm", "-f", temp_bin_path])
                else:
                    if os.path.exists(temp_bin_path):
                        os.remove(temp_bin_path)
            except Exception:
                pass
            raise e


