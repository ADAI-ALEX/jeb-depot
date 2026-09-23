//! llama.cpp `llama-server` as the JEB scoring engine, through its native `/completion` API.
//!
//! Request shape is the official engine's (`jeb/engines/llama_server.py`): the prompt as token ids, `n_predict=1`,
//! `n_probs=40`, `temperature=0`, and the answer distribution read from the full-vocabulary log-probabilities of the
//! first position. Labels outside the reported top list get a floor and are counted as missing, exactly as upstream.
//!
//! What differs is scheduling. Qwen3.5 is a hybrid model (Gated DeltaNet recurrent layers + attention); llama.cpp
//! cannot roll a recurrent state back to an arbitrary prefix, it can only restore a *context checkpoint*, and it
//! creates checkpoints 4 tokens before the end of a prompt. Sending every question of a request from scratch (the
//! upstream engine) therefore re-processes the whole state once per question. [`Scheduling::Primed`] instead:
//!
//! 1. once per server start, scores the constant `[system]` head so a checkpoint exists at its end;
//! 2. per request, scores the shared `[system][state]` prefix alone (checkpoint at prefix end - 4);
//! 3. scores each question's full prompt in the same slot, one after another: each restores that checkpoint and
//!    evaluates only the last 4 prefix tokens plus its own question tokens.
//!
//! The prompts, tokens and scoring position are unchanged, so the answers are the same up to floating-point noise
//! (measured on an M1 Pro: mean total-variation distance 9e-5 vs. from-scratch scoring, no top-answer flips).

use crate::prompt::Plan;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Instant;
use tokio::sync::Mutex;

pub const FLOOR_LOGPROB: f64 = -30.0;
pub const DEFAULT_N_PROBS: u32 = 40;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("engine unreachable: {0}")]
    Unreachable(String),
    #[error("engine HTTP {0}: {1}")]
    Http(u16, String),
    #[error("engine returned an unexpected response: {0}")]
    Protocol(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Scheduling {
    /// Prefix primed once, questions scored sequentially from its checkpoint (default).
    #[default]
    Primed,
    /// Every prompt evaluated from an empty cache (reference for verification).
    Scratch,
}

#[derive(Debug, Clone, Serialize)]
pub struct CallTiming {
    /// What the call was: "system", "prefix" or the question id.
    pub what: String,
    /// Prompt tokens the model actually evaluated for this call.
    pub prompt_n: u64,
    /// Prompt tokens reused from the slot's cache / a checkpoint.
    pub cache_n: u64,
    /// Model time reported by llama-server (prompt evaluation + the single sampled position).
    pub model_ms: f64,
    /// Wall time of the HTTP round trip seen from here.
    pub wall_ms: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct EngineTimings {
    pub calls: Vec<CallTiming>,
    /// Sum of llama-server's own timings: pure model inference.
    pub model_ms: f64,
    /// Wall time of all engine calls together (model + HTTP + JSON).
    pub wall_ms: f64,
    pub tokens_evaluated: u64,
    pub tokens_reused: u64,
}

#[derive(Debug, Clone)]
pub struct ScoreResult {
    /// Aligned with the plan's label ids; log-softmax over the full vocabulary.
    pub logprobs: Vec<f64>,
    pub missing: usize,
}

pub struct LlamaEngine {
    http: reqwest::Client,
    base: String,
    api_key: String,
    n_probs: u32,
    /// Token ids of the constant `[system]` head, primed once per server start.
    system_ids: Vec<u32>,
    /// Serialises requests: the priming scheme needs one slot to itself.
    state: Mutex<EngineState>,
}

struct EngineState {
    system_primed: bool,
}

impl LlamaEngine {
    pub fn new(base_url: &str, api_key: &str, system_ids: Vec<u32>) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(120))
            .no_proxy()
            .build()
            .expect("http client");
        LlamaEngine {
            http,
            base: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
            n_probs: DEFAULT_N_PROBS,
            system_ids,
            state: Mutex::new(EngineState { system_primed: false }),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    /// Forget cached server state (after a llama-server restart the checkpoints are gone).
    pub async fn reset(&self) {
        self.state.lock().await.system_primed = false;
    }

    pub async fn health(&self) -> Result<(), EngineError> {
        let r = self.http.get(format!("{}/health", self.base)).bearer_auth(&self.api_key).send().await.map_err(|e| EngineError::Unreachable(e.to_string()))?;
        if r.status().is_success() {
            Ok(())
        } else {
            Err(EngineError::Http(r.status().as_u16(), r.text().await.unwrap_or_default()))
        }
    }

    pub async fn props(&self) -> Result<Value, EngineError> {
        let r = self.http.get(format!("{}/props", self.base)).bearer_auth(&self.api_key).send().await.map_err(|e| EngineError::Unreachable(e.to_string()))?;
        if !r.status().is_success() {
            return Err(EngineError::Http(r.status().as_u16(), r.text().await.unwrap_or_default()));
        }
        r.json().await.map_err(|e| EngineError::Protocol(e.to_string()))
    }

    async fn complete(&self, ids: &[u32], n_probs: u32, cache_prompt: bool) -> Result<(Value, f64), EngineError> {
        let body = json!({
            "prompt": ids,
            "n_predict": 1,
            "n_probs": n_probs,
            "temperature": 0.0,
            "cache_prompt": cache_prompt,
            "id_slot": 0,
        });
        let t0 = Instant::now();
        let r = self
            .http
            .post(format!("{}/completion", self.base))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| EngineError::Unreachable(e.to_string()))?;
        let status = r.status();
        let text = r.text().await.map_err(|e| EngineError::Unreachable(e.to_string()))?;
        let wall = t0.elapsed().as_secs_f64() * 1000.0;
        if !status.is_success() {
            return Err(EngineError::Http(status.as_u16(), text.chars().take(300).collect()));
        }
        let v: Value = serde_json::from_str(&text).map_err(|e| EngineError::Protocol(format!("{e}: {}", text.chars().take(200).collect::<String>())))?;
        Ok((v, wall))
    }

    fn timing(what: &str, v: &Value, wall_ms: f64) -> CallTiming {
        let t = &v["timings"];
        CallTiming {
            what: what.to_string(),
            prompt_n: t["prompt_n"].as_u64().unwrap_or(0),
            cache_n: t["cache_n"].as_u64().unwrap_or(0),
            model_ms: t["prompt_ms"].as_f64().unwrap_or(0.0) + t["predicted_ms"].as_f64().unwrap_or(0.0),
            wall_ms,
        }
    }

    fn label_logprobs(v: &Value, label_ids: &[u32]) -> Result<ScoreResult, EngineError> {
        let cp = v["completion_probabilities"].as_array().ok_or_else(|| EngineError::Protocol("no completion_probabilities (is n_probs supported?)".into()))?;
        let first = cp.first().ok_or_else(|| EngineError::Protocol("empty completion_probabilities".into()))?;
        let mut by_id: Vec<(u32, f64)> = Vec::new();
        let mut push = |e: &Value| {
            if let (Some(id), Some(lp)) = (e["id"].as_u64(), e["logprob"].as_f64()) {
                if !by_id.iter().any(|(i, _)| *i as u64 == id) {
                    by_id.push((id as u32, lp));
                }
            }
        };
        push(first);
        for e in first["top_logprobs"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            push(e);
        }
        let floor = if by_id.is_empty() { FLOOR_LOGPROB } else { by_id.iter().map(|(_, lp)| *lp).fold(FLOOR_LOGPROB, f64::min) - 1.0 };
        let mut missing = 0;
        let logprobs = label_ids
            .iter()
            .map(|lid| match by_id.iter().find(|(i, _)| i == lid) {
                Some((_, lp)) => *lp,
                None => {
                    missing += 1;
                    floor
                }
            })
            .collect();
        Ok(ScoreResult { logprobs, missing })
    }

    /// Score every plan of one request. `prefix_ids` is the shared `[system][state]` prefix of all plans.
    pub async fn score(&self, prefix_ids: &[u32], plans: &[Plan], mode: Scheduling) -> Result<(Vec<ScoreResult>, EngineTimings), EngineError> {
        let mut st = self.state.lock().await;
        let t0 = Instant::now();
        let mut timings = EngineTimings::default();
        let mut results = Vec::with_capacity(plans.len());
        match mode {
            Scheduling::Primed => {
                if !st.system_primed && !self.system_ids.is_empty() && prefix_ids.starts_with(&self.system_ids) {
                    let (v, wall) = self.complete(&self.system_ids, 0, true).await?;
                    timings.calls.push(Self::timing("system", &v, wall));
                    st.system_primed = true;
                }
                let (v, wall) = self.complete(prefix_ids, 0, true).await?;
                timings.calls.push(Self::timing("prefix", &v, wall));
                for p in plans {
                    let (v, wall) = self.complete(&p.prompt_ids, self.n_probs, true).await?;
                    timings.calls.push(Self::timing(&p.qid, &v, wall));
                    results.push(Self::label_logprobs(&v, &p.label_ids)?);
                }
            }
            Scheduling::Scratch => {
                for p in plans {
                    let (v, wall) = self.complete(&p.prompt_ids, self.n_probs, false).await?;
                    timings.calls.push(Self::timing(&p.qid, &v, wall));
                    results.push(Self::label_logprobs(&v, &p.label_ids)?);
                }
                // A from-scratch call leaves the slot without the system checkpoint.
                st.system_primed = false;
            }
        }
        timings.model_ms = timings.calls.iter().map(|c| c.model_ms).sum();
        timings.tokens_evaluated = timings.calls.iter().map(|c| c.prompt_n).sum();
        timings.tokens_reused = timings.calls.iter().map(|c| c.cache_n).sum();
        timings.wall_ms = t0.elapsed().as_secs_f64() * 1000.0;
        Ok((results, timings))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_labels_get_a_floor_below_everything_reported() {
        let v = json!({"completion_probabilities": [{"id": 5, "logprob": -0.1, "top_logprobs": [{"id": 5, "logprob": -0.1}, {"id": 7, "logprob": -2.5}]}]});
        let r = LlamaEngine::label_logprobs(&v, &[7, 5, 9]).unwrap();
        assert_eq!(r.logprobs[..2], [-2.5, -0.1]);
        assert_eq!(r.logprobs[2], -31.0);
        assert_eq!(r.missing, 1);
    }
}
