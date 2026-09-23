//! JEB // DEPOT core: a faithful port of the JEB System One protocol (szybkie-ai/jeb@4990c9a: `schema.py`,
//! `prompt.py`, `decide.py`), a llama.cpp `llama-server` scoring engine for Apple Silicon, and the model/runtime
//! lifecycle used by the desktop app.

pub mod decide;
pub mod engine;
pub mod prompt;
pub mod runtime;
pub mod schema;
pub mod service;

pub use engine::Scheduling;
pub use service::{DecideOutput, JebService, ServiceError};
