//! Exactly what gets installed, pinned by revision and SHA-256 (see README "Model source").

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize)]
pub struct PinnedFile {
    pub id: &'static str,
    pub file_name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size: u64,
    /// `repo@revision` on Hugging Face, for the settings screen and update checks.
    pub repo: &'static str,
    pub revision: &'static str,
    pub path_in_repo: &'static str,
    pub description: &'static str,
}

/// JEB-4B (szybkie-ai/jeb-4b, round 3, 2026-09-20) converted to GGUF Q8_0 by mradermacher with stock llama.cpp.
/// Q8_0 was selected on this hardware class: fastest of Q8_0/Q6_K/Q4_K_M on M1 Pro Metal and closest to f16
/// (mean total-variation distance 0.004 over 90 robot decisions).
pub const MODEL_GGUF: PinnedFile = PinnedFile {
    id: "model",
    file_name: "jeb-4b.Q8_0.gguf",
    url: "https://huggingface.co/mradermacher/jeb-4b-GGUF/resolve/1cd0e3331840840912a81fa5752d2e627c6728f0/jeb-4b.Q8_0.gguf",
    sha256: "2966bfb34b48d4c0917018508be3859132a18296167e1a65c9cad83a10cf969e",
    size: 4_610_580_768,
    repo: "mradermacher/jeb-4b-GGUF",
    revision: "1cd0e3331840840912a81fa5752d2e627c6728f0",
    path_in_repo: "jeb-4b.Q8_0.gguf",
    description: "JEB-4B weights, GGUF Q8_0 (8-bit), text model",
};

/// The official tokenizer from the source model repository: prompts are tokenized with it, as the JEB server does.
pub const TOKENIZER: PinnedFile = PinnedFile {
    id: "tokenizer",
    file_name: "tokenizer.json",
    url: "https://huggingface.co/szybkie-ai/jeb-4b/resolve/e0031856fc0a8766596d8f70328e2292ff780070/tokenizer.json",
    sha256: "5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42",
    size: 12_807_982,
    repo: "szybkie-ai/jeb-4b",
    revision: "e0031856fc0a8766596d8f70328e2292ff780070",
    path_in_repo: "tokenizer.json",
    description: "JEB-4B tokenizer (Qwen3.5 vocabulary)",
};

pub const FILES: [PinnedFile; 2] = [TOKENIZER, MODEL_GGUF];

pub const MODEL_NAME: &str = "JEB-4B";
pub const MODEL_SOURCE: &str = "szybkie-ai/jeb-4b @ e0031856 (round 3, 2026-09-20)";
pub const QUANTISATION: &str = "GGUF Q8_0";

/// The llama.cpp build bundled inside the app (official release asset, verified by scripts/fetch-llama.sh).
pub const LLAMA_BUILD: u32 = 11149;
pub const LLAMA_COMMIT: &str = "d2e54583c";
pub const LLAMA_ASSET: &str = "llama-b11149-bin-macos-arm64.tar.gz";
pub const LLAMA_ASSET_SHA256: &str = "791eb0200a7c846ca925b6274fc21f0f21f537fda2924cc5a47402655816f56e";

/// Serving settings (see README "Runtime"): one slot for the priming scheme, a context that fits the longest prompt
/// with room to spare, all layers on the GPU, and llama-server's RAM prompt cache off (it would grow ~110 MB per
/// distinct robot state).
pub const CTX_SIZE: u32 = 4096;
pub const PARALLEL_SLOTS: u32 = 1;
pub const GPU_LAYERS: u32 = 999;

/// What the installer records after verifying a file, so later launches can skip re-hashing gigabytes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InstalledFile {
    pub id: String,
    pub file_name: String,
    pub sha256: String,
    pub size: u64,
    pub revision: String,
    pub repo: String,
    /// File modification time (seconds since epoch) when it was verified.
    pub mtime: i64,
    pub verified_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InstalledManifest {
    pub files: Vec<InstalledFile>,
}

impl InstalledManifest {
    pub fn get(&self, id: &str) -> Option<&InstalledFile> {
        self.files.iter().find(|f| f.id == id)
    }

    pub fn upsert(&mut self, f: InstalledFile) {
        self.files.retain(|x| x.id != f.id);
        self.files.push(f);
    }
}
