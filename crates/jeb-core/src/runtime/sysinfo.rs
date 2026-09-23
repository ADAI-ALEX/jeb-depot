//! Hardware and process measurements from public macOS interfaces (no root needed):
//! sysctl for CPU/memory/OS, IOKit's accelerator registry (via `ioreg`) for the GPU and its utilisation,
//! `proc_pidinfo` / `proc_pid_rusage` for the inference process' memory and CPU time.

use serde::Serialize;
use std::ffi::CString;
use std::path::Path;

fn sysctl_string(name: &str) -> Option<String> {
    let cname = CString::new(name).ok()?;
    let mut len: libc::size_t = 0;
    unsafe {
        if libc::sysctlbyname(cname.as_ptr(), std::ptr::null_mut(), &mut len, std::ptr::null_mut(), 0) != 0 || len == 0 {
            return None;
        }
        let mut buf = vec![0u8; len];
        if libc::sysctlbyname(cname.as_ptr(), buf.as_mut_ptr() as *mut libc::c_void, &mut len, std::ptr::null_mut(), 0) != 0 {
            return None;
        }
        buf.truncate(len);
        while buf.last() == Some(&0) {
            buf.pop();
        }
        String::from_utf8(buf).ok()
    }
}

fn sysctl_u64(name: &str) -> Option<u64> {
    let cname = CString::new(name).ok()?;
    let mut v: u64 = 0;
    let mut len = std::mem::size_of::<u64>() as libc::size_t;
    unsafe {
        if libc::sysctlbyname(cname.as_ptr(), &mut v as *mut u64 as *mut libc::c_void, &mut len, std::ptr::null_mut(), 0) != 0 {
            return None;
        }
    }
    Some(if len == 4 { v & 0xffff_ffff } else { v })
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub mac_model: String,
    pub cpu: String,
    pub performance_cores: u64,
    pub efficiency_cores: u64,
    pub memory_bytes: u64,
    pub gpu: String,
    pub gpu_cores: u64,
    pub os_version: String,
    pub os_build: String,
    pub arch: String,
}

pub fn hardware() -> Hardware {
    let gpu = gpu_registry();
    Hardware {
        mac_model: sysctl_string("hw.model").unwrap_or_default(),
        cpu: sysctl_string("machdep.cpu.brand_string").unwrap_or_default(),
        performance_cores: sysctl_u64("hw.perflevel0.physicalcpu").unwrap_or(0),
        efficiency_cores: sysctl_u64("hw.perflevel1.physicalcpu").unwrap_or(0),
        memory_bytes: sysctl_u64("hw.memsize").unwrap_or(0),
        gpu: gpu.model,
        gpu_cores: gpu.cores,
        os_version: sysctl_string("kern.osproductversion").unwrap_or_default(),
        os_build: sysctl_string("kern.osversion").unwrap_or_default(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GpuSample {
    pub model: String,
    pub cores: u64,
    /// IOAccelerator "Device Utilization %" (whole GPU, all processes).
    pub utilization_pct: Option<f64>,
    /// IOAccelerator "In use system memory" (bytes the GPU driver has resident).
    pub in_use_memory: Option<u64>,
}

fn find_num(text: &str, key: &str) -> Option<f64> {
    let i = text.find(key)? + key.len();
    let rest = text[i..].trim_start_matches(|c: char| c == '"' || c == ' ' || c == '=');
    let num: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    num.parse().ok()
}

fn find_str(text: &str, key: &str) -> Option<String> {
    let i = text.find(key)? + key.len();
    let rest = text[i..].trim_start_matches(|c: char| c == ' ' || c == '=');
    let rest = rest.strip_prefix('"')?;
    Some(rest.split('"').next()?.to_string())
}

/// One read of the GPU entry in the IOKit registry (~20 ms).
pub fn gpu_registry() -> GpuSample {
    let out = std::process::Command::new("/usr/sbin/ioreg").args(["-r", "-d", "1", "-c", "IOAccelerator", "-w0"]).output();
    let text = out.map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    GpuSample {
        model: find_str(&text, "\"model\"").unwrap_or_default(),
        cores: find_num(&text, "\"gpu-core-count\"").unwrap_or(0.0) as u64,
        utilization_pct: find_num(&text, "\"Device Utilization %\""),
        in_use_memory: find_num(&text, "\"In use system memory\"").map(|v| v as u64),
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSample {
    pub pid: i32,
    pub resident_bytes: u64,
    /// What Activity Monitor calls "Memory" (includes GPU-resident allocations of the process).
    pub footprint_bytes: u64,
    /// Total CPU time (user + system) since the process started, in seconds.
    pub cpu_seconds: f64,
}

#[allow(deprecated)] // libc still ships it; the mach2 crate is not worth a dependency for one call
fn timebase_ns_per_tick() -> f64 {
    let mut tb = libc::mach_timebase_info { numer: 0, denom: 0 };
    unsafe {
        libc::mach_timebase_info(&mut tb);
    }
    if tb.denom == 0 {
        1.0
    } else {
        tb.numer as f64 / tb.denom as f64
    }
}

pub fn process_sample(pid: i32) -> Option<ProcessSample> {
    unsafe {
        let mut ti: libc::proc_taskinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_taskinfo>() as i32;
        let n = libc::proc_pidinfo(pid, libc::PROC_PIDTASKINFO, 0, &mut ti as *mut _ as *mut libc::c_void, size);
        if n != size {
            return None;
        }
        let mut ru: libc::rusage_info_v2 = std::mem::zeroed();
        let footprint = if libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, &mut ru as *mut _ as *mut libc::rusage_info_t) == 0 { ru.ri_phys_footprint } else { 0 };
        // On Apple Silicon these counters are in Mach absolute-time ticks, not nanoseconds.
        let ticks = ti.pti_total_user + ti.pti_total_system;
        Some(ProcessSample { pid, resident_bytes: ti.pti_resident_size, footprint_bytes: footprint, cpu_seconds: ticks as f64 * timebase_ns_per_tick() / 1e9 })
    }
}

pub fn process_name(pid: i32) -> Option<String> {
    let mut buf = vec![0u8; 4096];
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    String::from_utf8(buf).ok()
}

/// Free space available to this user on the volume holding `path`.
pub fn free_space(path: &Path) -> Option<u64> {
    let mut p = path.to_path_buf();
    while !p.exists() {
        p = p.parent()?.to_path_buf();
    }
    let c = CString::new(p.as_os_str().to_string_lossy().as_bytes()).ok()?;
    unsafe {
        let mut s: libc::statfs = std::mem::zeroed();
        if libc::statfs(c.as_ptr(), &mut s) != 0 {
            return None;
        }
        Some(s.f_bavail * s.f_bsize as u64)
    }
}

/// Bytes used by a directory tree (model store size).
pub fn dir_size(path: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(path) else { return 0 };
    rd.flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_this_mac() {
        let h = hardware();
        assert!(h.memory_bytes > 0);
        assert!(!h.cpu.is_empty());
        let me = process_sample(std::process::id() as i32).unwrap();
        assert!(me.resident_bytes > 0);
    }

    #[test]
    fn parses_ioreg_text() {
        let t = r#""model" = "Apple M1 Pro"  "gpu-core-count" = 16 "PerformanceStatistics" = {"Device Utilization %"=47,"In use system memory"=159449088}"#;
        assert_eq!(find_str(t, "\"model\"").unwrap(), "Apple M1 Pro");
        assert_eq!(find_num(t, "\"gpu-core-count\""), Some(16.0));
        assert_eq!(find_num(t, "\"Device Utilization %\""), Some(47.0));
    }
}
